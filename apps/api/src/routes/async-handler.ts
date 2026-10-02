import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * 让 async 路由的错误能走到错误中间件。
 *
 * Express 4 不会等 async 函数返回的 Promise。一个 `async (req, res) => { throw ... }`
 * 抛出的错会变成一次 unhandled rejection，后面的错误中间件一次都收不到
 * ——它只处理同步 throw。
 *
 * **实际后果不是「请求挂住」，是整个进程退出。** 本机实测：拆掉这里的
 * 包裹后打一个会抛错的请求，curl 拿到 `HTTP 000`（连接被关，一个字节没收到），
 * 紧接着 health 探针也是 `000`，Node 进程已经不在了。原因是 Node 15 之后
 * unhandled rejection 默认让进程退出。
 *
 * 也就是说，一条非法参数的请求能打死整个服务，当时在处理的所有请求一起死。
 * 包裹之后 fn 返回的 Promise 被接住，reject 时转成 next(err)，
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
