import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * 让 async 路由的错误能走到错误中间件。
 *
 * Express 4 不会等 async 函数返回的 Promise。一个 `async (req, res) => { throw ... }`
 * 抛出的错会变成一次 unhandled rejection，请求挂在那儿直到超时，
 * 后面的错误中间件一次都收不到——它只处理同步 throw。
 * 而我们这一层的 db 方法全是 async，等于每个路由都会踩这个坑。
 *
 * 包裹之后，fn 返回的 Promise 被接住，reject 时转成 next(err)，
 * next(err) 才会进入 Express 的错误处理流程。
 *
 * Express 5 会自己处理这件事。升版本是另一回事（要过一遍中间件兼容性），
 * 这里用六行代码解决，成本更低也更可控。
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}
