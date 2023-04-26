# postgres-ipc
PG-Client wrapper for making NOTIFY/LISTEN/UNLISTEN queries. Exposed as async functions or as an EventEmitter (continuation of `pg-ipc`).
> See more about Postgres notifications here: https://www.postgresql.org/docs/15/libpq-notify.html

## Features
- easy switch from abandoned [pg-ipc](https://github.com/emilbayes/pg-ipc) project
- seamless EventEmitter interface with typings
- async methods for more controlled access
- auto reconnect without console spam (you wont even notice a disconnect occurred - well as long you don't try and query the client while it's disconnected)

## Example 1: It's just an EventEmitter?
```js
import PostgresIPCClient from 'postgres-ipc'
// const PostgresIPCClient = require('postgres-ipc')

// Same constructor as Client form pg but defaults to process.env.POSTGRES_CONN_URI
const ipc = new PostgresIPCClient(process.env.POSTGRES_CONN_URI)

// You can add listeners before connecting.
ipc.on("channel-name", (notification) => {
    if (notification.processId === ipc.processId) return // Ignore notifications sent by this client like this.
    console.log(notification.payload.message)
})
// Once connected it will auto query 'LISTEN channel-name' since you added this listener here.

// Haven't connected yet? No problem... This NOTIFY query will automatically be sent once you connect.
ipc.emit("channel-name", { message: "hello" })

// Basically the same thing but this is awaitable, will return the error (not throw it) 
// and already logs the error to console.error for you.
ipc.notify("channel-name", { message: "hello" })

// This is a deprecated alias for notify bcs pg-ipc had this.
ipc.send("channel-name", { message: "hello" })

// Remember to connect ;)
ipc.connect().then(async () => {
    // once destroyed you can't connect again
    await ipc.destroy()
    // also feel free to call this as many times as you feel fit
    await ipc.destroy()
})

// You can call connect as many times as your heart desires.
ipc.connect() 
```

## Example 2: Let me await that
```js
import PostgresIPCClient from 'postgres-ipc'
// const PostgresIPCClient = require('postgres-ipc')

const ipc = new PostgresIPCClient()
ipc.connect().then(async () => {
    await ipc.listen("channel")
    await ipc.listen(["channel1", "channel2"])
    
    await ipc.unlisten("channel")
    await ipc.unlisten(["channel1", "channel2"])
    await ipc.unlisten() // (Unlisten to all)
    console.log(ipc.channels()) // These are the channels you are currently listening for.

    await ipc.notify("IMPORTANT", "Remember this won't throw an error, it will return an error that has already been logged.")
    await ipc.destroy()
})
```

## Take a look at these events
```js
ipc.on('notification', (notification) => console.log("Notification from any channel!", notification))
ipc.on('notify', (channel, payload) => console.log("A PG NOTIFY query was successfully made!", channel, payload))
ipc.on('debug', (message) => console.log("See exactly what's happening:", message))
// console.error is already added as a default error handler. Your own listener will overwrite it though.
ipc.on('error', (err) => console.log("One of your listeners threw an error:", err))
ipc.on('end', () => console.log("I was once connected but I got destroyed :("))
```

## Install
``` npm install postgres-ipc ```