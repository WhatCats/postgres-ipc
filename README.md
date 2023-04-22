# postgres-ipc
``` npm install postgres-ipc ```

PGClient wrapper for triggering and listening to notification.

> See more about Postgres notifications here: https://www.postgresql.org/docs/15/libpq-notify.html

## Disconnects
Disconnects could occur with the database if network issues occur or if the database process is restarted.
In the case of a disconnect this will <ins><b>automatically try reconnecting until it is successful or destrpyed</b></ins> with a 5 second cooldown.
Once reconnected it will automatically start listening to all of the channels you added listeners for again.
To see the reconnect process in action, add a listener to the debug event like shown in the example below.

## Example
```js
// Same constructor as Client form pg but defaults to process.env.POSTGRES_CONN_URI
const ipc = new PostgresIPCClient(process.env.POSTGRES_CONN_URI)
ipc.on("debug", console.log) // optional debug content if needed
ipc.on("error", console.error) // This is recommended. All uncaught errors from your (async) listeners will end up here.

// You can add listeners before connecting but they won't get called until you connect
ipc.on("channel-name", (notification) => {
    if (notification.processId === ipc.processId) return // ignore notifications sent by this client like this
    console.log(notification.payload.message)
})

ipc.connect().then(async () => {
    // this returns a promise but it does not throw errors so you can choose not to await this safely
    // returns Promise<undefined> if successful and Promise<Error> if error
    // (the error is already sent to console.error so no need to worry about logging the error)
    await ipc.notify("channel-name", { message: "hello" })

    // once destroyed you can't connect again
    await ipc.destroy()
    // also feel free to call this as many times as you feel fit
    await ipc.destroy()
})

ipc.notify("channel-name", { message: "hello" }) // Calling notify before connecting will result in an error!!!
ipc.connect() // you can call connect as many times as you want without errors
```

## Credits
Credit to https://github.com/emilbayes/pg-ipc but seems to have been abandoned :/ so I created a newer, typescript version.