import { ClientConfig, Notification, Client as PGClient } from "pg"
import { EventEmitter } from "events"

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000))
const RESERVED_CHANNELS = ["newListener", "removeListener", "notification", "notify", "error", "debug", "end"]

type Status = "initial" | "connecting" | "reconnecting" | "connected" | "ending" | "terminated" | "dead"

class PostgresIPCClient extends EventEmitter {
    protected config: ClientConfig
    protected _client!: PGClient
    protected _status: Status = "initial"
    protected _channels: Set<string> = new Set()

    constructor(config: string | ClientConfig = {}) {
        super({ captureRejections: true })

        if (typeof config === "string") config = { connectionString: config }
        if (config.connectionTimeoutMillis === undefined) config.connectionTimeoutMillis = 10 * 1000
        if (!config.connectionString && !config.host) config.connectionString = process.env.POSTGRES_CONN_URI

        this.config = config
        this.createClient()

        const dispatch = (channel: string | symbol): channel is string => {
            return (
                this.status === "connected" &&
                typeof channel === "string" &&
                !RESERVED_CHANNELS.includes(channel)
            )
        }

        this.on("newListener", (channel: string | symbol) => {
            if (dispatch(channel) && !this._channels.has(channel)) this.listen(channel).catch(console.error)
        })

        this.on("removeListener", (channel: string | symbol) => {
            if (dispatch(channel) && this.listenerCount(channel) === 0 && this._channels.has(channel))
                this.unlisten(channel).catch(console.error)
        })
    }

    get status() {
        return this._status
    }

    get client() {
        return this._client
    }

    get processId() {
        return ((this.client as any)?.processID ?? null) as number | null
    }

    /** All PG channels you are currently listening for */
    channels() {
        return this.eventNames()
            .concat(...this._channels)
            .filter((v) => typeof v === "string" && !RESERVED_CHANNELS.includes(v)) as string[]
    }

    async connect() {
        if (this.status === "initial" || this.status === "reconnecting") {
            if (this.status === "initial") this._status = "connecting"
            await this.client.connect()
            this._status = "connected"
            this.emit("debug", `PG-IPC Connected`)
            await this.listen(this.channels()).catch(console.error)
        }
    }

    async destroy() {
        const status = this._status
        if (status === "connected" || status === "reconnecting") {
            this._status = "ending"
            if (status === "connected") await this.unlisten().catch(console.error)
            this.client.removeAllListeners()
            this.emit("end")
            this.emit("debug", `PG-IPC Closing after destroy was called`)
            this.removeAllListeners()
            await this.client.end().catch(console.error)
            this._status = "terminated"
        }
    }

    /**
     * @param payload non-string data will be auto encoded to JSON -
     * In the default configuration it must be shorter than 8000 bytes.
     * (If binary data or large amounts of information need to be communicated, it's best to put it in a database table and send the key of the record.)
     * @returns error if there was one after calling console.error
     */
    async notify(channel: string, payload: any = null) {
        const encoded = (
            typeof payload === "string" || payload === null ? payload : JSON.stringify(payload)
        ) as string
        const res = await this.query(`SELECT pg_notify($1, $2)`, [channel, encoded])
            .then(() => this.emit("debug", `PG-IPC Message sent over '${channel}' channel`))
            .then(() => this.emit("notify", channel, payload))
            .catch((err) => {
                console.error(err)
                return err
            })

        if (res instanceof Error) return res
    }

    async listen(channelOrChannels: string | string[]) {
        const channels = (
            typeof channelOrChannels === "string" ? [channelOrChannels] : channelOrChannels
        ).filter((channel) => !RESERVED_CHANNELS.includes(channel))
        const query = channels.map((channel) => `LISTEN ${this.client.escapeIdentifier(channel)}`)
        if (query.length > 0) {
            await this.query(query.join(";"))
            channels.forEach((channel) => this._channels.add(channel))
            this.emit("debug", `PG-IPC ran listen for channels [${channels.join(", ")}]`)
        }
    }

    /**
     * This will also remove any listeners added for `channelOrChannels`
     * @param channelOrChannels leave undefined to unlisten from all channels
     */
    async unlisten(channelOrChannels?: string | string[]) {
        const channels = typeof channelOrChannels === "string" ? [channelOrChannels] : channelOrChannels
        if (channels === undefined) {
            await this.query("UNLISTEN *")
            this._channels.forEach((channel) => {
                this._channels.delete(channel)
                this.removeAllListeners(channel)
            })
            this.emit("debug", `PG-IPC ran unlisten for all channels`)
        } else {
            const remove = channels.filter((channel) => !RESERVED_CHANNELS.includes(channel))
            const query = remove.map((channel) => `UNLISTEN ${this.client.escapeIdentifier(channel)}`)
            if (query.length > 0) {
                await this.query(query.join(";"))
                remove.forEach((channel) => this._channels.delete(channel))
                channels.forEach((channel) => this.removeAllListeners(channel))
                this.emit("debug", `PG-IPC ran unlisten for channels [${remove.join(", ")}]`)
            }
        }
    }

    async query(query: string, params?: any[]) {
        if (this.status === "dead" || this.status === "reconnecting")
            throw Error(`PG-IPC-Client has encountered a connection error and is currently not queryable.`)
        if (this.status === "terminated") throw Error(`PG-IPC-Client was shutdown and is not queryable.`)
        return this.client.query(query, params)
    }

    protected createClient() {
        if (this.client) this.client.removeAllListeners()
        this._client = new PGClient(this.config)
        this._client.on("notification", (msg) => this.onNotification(msg).catch(console.error))
        this._client.on("error", (error) => {
            if (this._status === "connected") {
                this._status = "dead"
                this.emit("debug", `PG-IPC connection terminated unexpectedly! (${error})`)
                this.reconnect()
            }
        })
    }

    protected async reconnect() {
        if (this.status === "dead") {
            this._status = "reconnecting"
            this.emit("debug", `PG-IPC attempting reconnect after 5 seconds...`)
            await sleep(5)
            this.createClient()
            await this.connect().catch((err) => this.reconnectError(err))
        }
    }

    protected async reconnectError(err: Error) {
        this._status = "dead"
        this.emit("debug", `PG-IPC failed to reconnect! (${err})`)
        this.reconnect()
    }

    protected async onNotification(msg: Notification) {
        this.emit("debug", `PG-IPC received notification over '${msg.channel}' channel`)
        try {
            if (msg.payload) msg.payload = JSON.parse(msg.payload)
        } catch (err) {
            /** Payload is not JSON content but thats OK */
        } finally {
            this.emit("notification", msg as PGNotification)
            this.emit(msg.channel, msg as PGNotification)
        }
    }

    emit(event: string, notification: PGNotification): boolean
    emit<K extends keyof ThisEvents>(event: K, ...args: ThisEvents[K]): boolean
    emit(event: string, ...args: any[]): boolean {
        return super.emit(event, ...args)
    }

    on(event: string, listener: (notification: PGNotification) => unknown): this
    on<K extends keyof ThisEvents>(event: K, listener: (...args: ThisEvents[K]) => unknown): this
    on(event: string, listener: (...args: any[]) => unknown): this {
        return super.on(event, listener)
    }

    once(event: string, listener: (notification: PGNotification) => unknown): this
    once<K extends keyof ThisEvents>(event: K, listener: (...args: ThisEvents[K]) => unknown): this
    once(event: string, listener: (...args: any[]) => unknown) {
        return super.once(event, listener)
    }

    off(event: string, listener: (notification: PGNotification) => unknown): this
    off<K extends keyof ThisEvents>(event: K, listener: (...args: ThisEvents[K]) => unknown): this
    off(event: string, listener: (...args: any[]) => unknown) {
        return super.off(event, listener)
    }
}

interface PGNotification extends Notification {
    length: number
    /** JSON payload will be automatically parsed as such */
    payload: any
}

interface ThisEvents {
    newListener: [channel: string]
    removeListener: [channel: string]
    notification: [notification: PGNotification]
    notify: [channel: string, payload: any]
    debug: [message: string]
    error: [error: any]
    end: []
}

export = PostgresIPCClient
