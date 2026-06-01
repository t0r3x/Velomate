import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import path from 'path'
import fs from 'fs'

const LOG_DIR_RAW = process.env.LOG_DIR || './logs'
const LOG_DIR = path.isAbsolute(LOG_DIR_RAW)
  ? LOG_DIR_RAW
  : path.resolve(process.cwd(), LOG_DIR_RAW)

fs.mkdirSync(LOG_DIR, { recursive: true })

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf(({ level, message }) => `${level}: ${message}`)
)

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) =>
    `[${timestamp}] ${level.toUpperCase()}: ${message}`
  )
)

const rotateTransport = new DailyRotateFile({
  dirname:      LOG_DIR,
  filename:     'velomate-%DATE%.log',
  datePattern:  'YYYY-MM-DD',
  maxFiles:     '30d',
  zippedArchive: true,
  format:       fileFormat,
})

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    rotateTransport,
  ],
})

export default logger
