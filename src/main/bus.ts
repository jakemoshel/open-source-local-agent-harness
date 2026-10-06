import { EventEmitter } from 'node:events'

export const bus = new EventEmitter()
bus.setMaxListeners(100)

export type BusChannel =
  | 'run:update'
  | 'run:event'
  | 'run:delta'
  | 'approval:update'
  | 'config:changed'
  | 'gateway:update'
  | 'audit:new'
  | 'run:finished'
  | 'update:status'
