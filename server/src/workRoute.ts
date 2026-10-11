import type { Express, Request, Response } from 'express'
import type { RoomStore } from './roomStore'
import type { Limits } from './limits'
import { createRateLimiter } from './rateLimit'
import { extractIp } from './clientIp'
import { normalizeRoomCode } from './validation'

// 合成済みの作品を配る。部屋コードだけでは取れない：コードは4〜6桁で総当たりでき、
// トークンが無いと無関係な第三者が他人の演技音声を引けてしまう。
export function createWorkRoute(deps: { rooms: RoomStore; limits: Limits }): (app: Express) => void {
  const { rooms, limits } = deps
  const limiter = createRateLimiter(limits.workRateWindowMs, limits.workRateMax)

  return function registerWorkRoute(app: Express): void {
    app.get('/work/:code/:token', (req: Request, res: Response) => {
      const ip = req.ip ?? extractIp(req.headers['x-forwarded-for'], undefined)
      if (!limiter.allow(ip, Date.now())) {
        res.status(429).end()
        return
      }
      const room = rooms.get(normalizeRoomCode(req.params.code ?? ''))
      // 失敗理由を撃ち分けない。部屋の存在も作品の有無も漏らさず、すべて 404 に倒す。
      if (!room || !room.work || !room.workToken || room.workToken !== req.params.token) {
        res.status(404).end()
        return
      }
      res.set('content-type', 'audio/mp4')
      res.set('cache-control', 'no-store')
      res.send(room.work)
    })
  }
}
