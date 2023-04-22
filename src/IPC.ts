import { ClientConfig, Notification, Client as PGClient } from "pg"
import { EventEmitter } from "events"

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000))
const RESERVED_CHANNELS = [
    "newListener",
    "removeListener",
    "notification",
    "unlisten",
    "notify",
    "listen",
    "error",
    "debug",
    "end"
]

type Status = "initial" | "connecting" | "reconnecting" | "connected" | "ending" | "terminated" | "dead"

class PostgresIPCClient extends EventEmitter {
    protected config: ClientConfig
    protected _client!: PGClient
    protected _status: Status = "initial"

    constructor(config: string | ClientConfig = {}) {
        super({ captureRejections: true })

        if (typeof config === "string") config = { connectionString: config }
        if (config.connectionTimeoutMillis === undefined) config.connectionTimeoutMillis = 10 * 1000
        if (!config.connectionString && !config.host) config.connectionString = process.env.POSTGRES_CONN_URI

        this.config = config
        this.createClient()

        const dispatch = (channel: string) => {
            return (
                this._status === "connected" &&
                !RESERVED_CHANNELS.includes(channel) &&
                this.listenerCount(channel) === 0
            )
        }

        this.on("newListener", (channel: string) => {
            if (dispatch(channel)) this.dispatchListen(channel)
        })
        this.on("removeListener", (channel: string) => {
            if (dispatch(channel)) this.dispatchUnlisten(channel)
        })
    }

    get status() {
        return this._status
    }

    get client() {
        return this._client
    }

    get processId() {
        return (this._client as any).processID as number | null
    }

    async connect() {
        if (["initial", "reconnecting"].includes(this._status)) {
            if (this._status === "initial") this._status = "connecting"
            await this._client.connect()
            this._status = "connected"
            this.emit("debug", `PG-IPC Connected`)
            await this.addListens()
        }
    }

    protected async addListens() {
        const channels = this.eventNames().filter((v) => !RESERVED_CHANNELS.includes(v as string))
        this.emit("debug", `PG-IPC adding listeners for channels [${channels.join(", ")}]`)
        const query = channels.map((channel) => `LISTEN ${this._client.escapeIdentifier(channel as string)}`)
        await this._client.query(query.join(";")).catch(console.error)
    }

    protected async reconnect() {
        if (this._status === "dead") {
            this._status = "reconnecting"
            this.emit("debug", `PG-IPC attempting reconnect after 5 seconds...`)
            await sleep(5)
            this.createClient()
            await this.connect().catch((err) => this.reconnectError(err))
        }
    }

    protected async reconnectError(err: Error) {
        this._status = "dead"
        this.emit("debug", `PG-IPC failed to reconnect! ${err}`)
        this.reconnect()
    }

    async destroy() {
        const status = this._status
        if (status === "connected" || status === "reconnecting") {
            this._status = "ending"
            if (status === "connected") await this._client.query(`UNLISTEN *`).catch(console.error)
            this._client.removeAllListeners()
            this.emit("end")
            this.removeAllListeners()
            await this._client.end().catch(console.error)
            this._status = "terminated"
            this.emit("debug", `PG-IPC Terminated`)
        }
    }

    protected createClient() {
        if (this._client) this._client.removeAllListeners()
        this._client = new PGClient(this.config)
        this._client.on("notification", (msg) => this.onNotification(msg).catch(console.error))
        this._client.on("error", (error) => {
            if (this._status === "connected") {
                this._status = "dead"
                this.emit("debug", `PG-IPC connection terminated unexpectedly! ${error}`)
                this.reconnect()
            }
        })
    }

    /**
     * @returns error if there was one
     */
    async notify(channel: string, payload: any = null) {
        const encoded = typeof payload === "string" || payload === null ? payload : JSON.stringify(payload)
        const res = await this._client
            .query(`SELECT pg_notify($1, $2)`, [channel, encoded])
            .then(() => this.emit("notify", channel, payload))
            .catch((err) => {
                console.error(err)
                return err
            })

        if (res instanceof Error) return res
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

    protected async dispatchListen(channel: string) {
        await this._client
            .query(`LISTEN ${this._client.escapeIdentifier(channel)}`)
            .then(() => this.emit("listen", channel))
    }

    protected async dispatchUnlisten(channel: string) {
        await this._client
            .query(`UNLISTEN ${this._client.escapeIdentifier(channel)}`)
            .then(() => this.emit("unlisten", channel))
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
    payload: any
}

interface ThisEvents {
    newListener: [channel: string]
    removeListener: [channel: string]
    notification: [notification: PGNotification]
    notify: [channel: string, payload: any]
    unlisten: [channel: string]
    listen: [channel: string]
    debug: [message: string]
    error: [error: any]
    end: []
}

export = PostgresIPCClient
