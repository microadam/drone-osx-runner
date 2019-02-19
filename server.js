const Primus = require('primus')
const Emitter = require('primus-emitter')
const http = require('http')
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const hat = require('hat')
const rimraf = require('rimraf')

const server = http.createServer()

const primus = new Primus(server, { parser: 'ejson', plugin: { emitter: Emitter } })
const authKey = process.env.AUTH_KEY
console.log('Started!')

const runCommands = (commands, env, workingDir, spark, done) => {
  const cmd = spawn('bash', [ '-c', commands ], { cwd: workingDir, env: { ...env, ...process.env } })
  cmd.stdout.on('data', data => {
    spark.send('log', { msg: data.toString() })
  })
  cmd.stderr.on('data', data => {
    spark.send('log', { msg: data.toString() })
  })
  cmd.on('error', done)
  cmd.on('close', code => {
    if (code > 0) return done(new Error('Error running commands'))
    done()
  })
}

const sendOutputContext = (outputContext, workingDir, spark) => {
  const context = execSync('echo "' + outputContext + '" | tar -c --files-from - | zstd', { cwd: workingDir })
  spark.send('outputContext', { context })
}

primus.on('connection', spark => {
  console.log('connected')
  const connectTime = Date.now()
  let isAuthed = false
  const workingDir = '/tmp/drone-osx-runner-' + hat()
  console.log('workingDir: ', workingDir)
  fs.mkdirSync(workingDir)
  const cat = spawn('zstdcat', [ '-' ])
  const tar = spawn('tar', [ 'xC', workingDir ])
  cat.stdout.pipe(tar.stdin).pipe(tar.stdout)

  cat.stderr.on('data', data => {
    console.log('CAT STDERR:', data.toString())
    spark.send('log', { msg: data.toString() })
  })
  cat.on('error', error => {
    console.log('ERROR:', error)
  })

  tar.stdout.on('data', data => {
    console.log('TAR STDOUT:', data.toString())
    spark.send('log', { msg: data.toString() })
  })
  tar.stderr.on('data', data => {
    console.log('TAR STDERR:', data.toString())
    spark.send('log', { msg: data.toString() })
  })
  tar.on('error', error => {
    console.log('ERROR:', error)
  })
  tar.on('close', code => {
    if (code > 0) {
      return console.log('Untarring failed')
    }
    const now = Date.now()
    console.log('Input Context Transfer Time:', (now - connectTime) / 1000)
    spark.send('inputContextProcessed')
  })

  spark.on('end', () => {
    console.log('disconnected')
    rimraf.sync(workingDir)
  })

  spark.on('auth', data => {
    console.log('AUTH REQUEST RECEIVED')
    if (data.key === authKey) {
      isAuthed = true
      console.log('AUTH SUCCESSFUL')
      spark.send('authSuccess')
    } else {
      console.log('AUTH FAILED!')
      spark.send('authFail')
    }
  })

  spark.on('outputContextProcessed', data => {
    if (!isAuthed) return spark.end()
    console.log('Deleting:', workingDir)
    rimraf.sync(workingDir)
  })

  spark.on('data', data => {
    if (!isAuthed) return spark.end()
    if (data.eof) return cat.stdin.end()
    if (!data.type && !data.data) cat.stdin.write(data)
  })

  spark.on('task', data => {
    if (!isAuthed) return spark.end()
    spark.send('log', { msg: 'Commands recieved. Executing...' })
    console.log('Commands:', data.commands)
    const commandStartTime = Date.now()
    runCommands(data.commands, data.env, workingDir, spark, (error) => {
      if (error) {
        console.log('FATAL ERROR:', error.message)
        rimraf.sync(workingDir)
        return spark.send('fatalError', { msg: error.message })
      }
      const now = Date.now()
      console.log('Command Execution Time:', (now - commandStartTime) / 1000)
      spark.send('log', { msg: 'Commands Executed.' })
      spark.send('commandsExecuted')
      if (data.outputContext) {
        spark.send('log', { msg: 'Sending output context...' })
        sendOutputContext(data.outputContext, workingDir, spark)
      }
    })
  })
})

server.listen(3000)