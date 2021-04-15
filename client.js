const Primus = require('primus')
const Emitter = require('primus-emitter')
const { spawn } = require('child_process')
const workingDir = '/drone/src'

const osxHost = process.env.PLUGIN_HOST || 'http://localhost:3000'
const authKey = process.env.PLUGIN_KEY
const commands = process.env.PLUGIN_COMMANDS ? process.env.PLUGIN_COMMANDS.replace(/,/g, '\n') : 'echo NO COMMANDS PROVIDED'
const inputContext = process.env.PLUGIN_INPUTCONTEXT ? process.env.PLUGIN_INPUTCONTEXT.replace(/,/g, '\n') : '.'
const outputContext = process.env.PLUGIN_OUTPUTCONTEXT ? process.env.PLUGIN_OUTPUTCONTEXT.replace(/,/g, '\n') : null

const socketOptions = { transformer: 'websockets', parser: 'ejson', plugin: { emitter: Emitter } }

const Socket = Primus.createSocket(socketOptions)
const client = new Socket(osxHost, { transport: { maxPayload: 209715200 } })

client.on('error', error => {
  console.log('ERROR:', error)
})

client.on('close', () => {
  console.log('Connection closed...')
})

client.on('reconnect', () => {
  console.log('RECONNNECTING...')
})

client.on('reconnected', opts => {
  console.log('RECONNECTED: %d ms', opts.duration)
})

client.on('end', () => {
  console.log('Disconnected from runner')
})

client.on('open', () => {
  console.log('Connected to runner...')
  client.on('fatalError', data => {
    console.log('FATAL ERROR:', data.msg)
    process.exit(1)
  })
  client.on('log', data => {
    console.log(data.msg)
  })
  client.on('commandsExecuted', data => {
    if (!outputContext) {
      client.end()
      console.log('Commands executed. No output context. Done.')
    }
  })
  client.on('inputContextProcessed', data => {
    console.log('Input context processed. Sending commands...')
    client.send('task', { commands, env: process.env, outputContext })
  })
  client.on('outputContext', data => {
    console.log('Output context received. Processing...')
    const cat = spawn('zstdcat', [ '-' ])
    const tar = spawn('tar', [ 'x' ], { cwd: workingDir })
    cat.stdout.pipe(tar.stdin).pipe(tar.stdout)
    cat.stdin.write(data.context)
    cat.stdin.end()

    cat.stderr.on('data', data => {
      console.log(data.toString())
    })
    cat.on('error', error => {
      throw error
    })

    tar.stdout.on('data', data => {
      console.log(data.toString())
    })
    tar.stderr.on('data', data => {
      console.log(data.toString())
    })
    tar.on('error', error => {
      throw error
    })
    tar.on('close', code => {
      client.send('outputContextProcessed')
      client.end()
      console.log('Output context processed. Done.')
    })
  })
  client.on('authSuccess', data => {
    console.log('Auth successful!')
    console.log('Sending input context...')
    const tar = spawn('tar', [ '-c', '--files-from', '-' ], { cwd: workingDir })
    const zstd = spawn('zstd', [ '--adapt', '-T0', '--long=31' ], { cwd: workingDir })

    zstd.stdout.on('data', data => {
      client.write(data)
    })

    tar.stdout.pipe(zstd.stdin).pipe(zstd.stdout)
    tar.stdin.write(inputContext)
    tar.stdin.end()

    tar.on('error', error => {
      throw error
    })
    zstd.on('close', code => {
      client.write({ eof: true })
    })
  })

  console.log('Sending auth...')
  client.send('auth', { key: authKey })
})