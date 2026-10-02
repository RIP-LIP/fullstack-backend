import { createApp } from './app.ts'
import { PORT } from './config.ts'

/**
 * 入口：读端口、监听、打印实际地址。
 *
 * 端口从 config.ts 读，默认 3002（不是 3001——那个被 fullstack-todo-app 占了）。
 * 启动完打印一个可以直接复制去试的 curl，省得读者自己拼路径。
 */
const app = createApp()

app.listen(PORT, () => {
  console.log(`[api] 已启动 → http://localhost:${PORT}`)
  console.log(`[api] 试一下：curl -i http://localhost:${PORT}/api/health`)
})
