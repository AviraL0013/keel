const fs = require('node:fs')

const logPath = process.env.EYELER_LOCAL_LOG_FILE
if (!logPath) throw new Error('EYELER_LOCAL_LOG_FILE_MISSING')
const log = fs.openSync(logPath, 'a')

for (const stream of [process.stdout, process.stderr]) {
  const originalWrite = stream.write.bind(stream)
  stream.write = (chunk, encoding, callback) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
    fs.writeSync(log, bytes)
    return originalWrite(chunk, encoding, callback)
  }
}
