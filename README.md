# postgres-ipc
``` npm install postgres-ipc ```

PGClient wrapper for triggering and listening to notification.

> See more about Postgres notifications here: https://www.postgresql.org/docs/15/libpq-notify.html

## Disconnects
Network issues could occur or the database process may get restarted while your application is running.
In the case of a disconnect this will <ins><b>automatically try reconnecting until it is successful or destroyed</b></ins> with a 5 second cooldown.
While the client is disconnected any `.query()` call including `.notify()` will throw an error.
Once reconnected it will automatically start listening to all of the channels you added listeners for again.
To see the reconnect process in action, add a listener to the debug event like shown in the example below.

## Basic Example
```js
// Same constructor as Client form pg but defaults to process.env.POSTGRES_CONN_URI
const ipc = new PostgresIPCClient(process.env.POSTGRES_CONN_URI)
ipc.on("debug", console.log) // optional debug content if needed
ipc.on("error", console.error) // This is recommended. All uncaught errors from your (async) listeners will end up here.
ipc.on("end", () => console.log("This is called when destroy is called if the client was previously connected."))

// You can add listeners before connecting.
ipc.on("channel-name", (notification) => {
    if (notification.processId === ipc.processId) return // Ignore notifications sent by this client like this.
    console.log(notification.payload.message)
})
// Once connected it will auto query 'LISTEN channel-name' since you added this listener here.

ipc.connect().then(async () => {
    // this returns a promise but it does not throw errors so you can choose not to await this safely.
    // returns Promise<undefined> if successful and Promise<Error> if error
    // (The error is already sent to console.error so no need to worry about logging the error.)
    ipc.notify("channel-name", { message: "hello" })

    // once destroyed you can't connect again
    await ipc.destroy()
    // also feel free to call this as many times as you feel fit
    await ipc.destroy()
})

// Calling notify before connecting will wait for the PG-Client to connect and make the notify query before resolving the result promise.
// If the client was destroyed or got disconnected this will throw an error.
ipc.notify("channel-name", { message: "hello" }) 
ipc.connect() // You can call connect as many times as you want without errors.
```

## Using async methods to listen & unlisten
```js
const ipc = new PostgresIPCClient()
ipc.on("error", console.error)
ipc.on("notify", (event, payload) => console.log("notify called", event, payload))
ipc.on("notification", (notification) => {
    if (notification.channel === "channel") console.log(notification.payload)
})

ipc.connect().then(async () => {
    await ipc.listen("channel")
    await ipc.listen(["channel1", "channel2"])
    
    await ipc.unlisten("channel2")
    console.log(ipc.channels()) // These are the channels you are currently listening for.

    // This will log 'notify called channel Hello!' bcs of the .on("notify") listener above.
    // This will also log 'Hello!' bcs of the .on("notification") listener above.
    await ipc.notify("channel", "Hello!")

    await ipc.destroy()
})
```

## Credits
Credit to https://github.com/emilbayes/pg-ipc but seems to have been abandoned :/ so I created a newer, typescript version.