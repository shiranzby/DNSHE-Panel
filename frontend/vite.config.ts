import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  // 🔴 构建期硬校验：Cloudflare / Docker 两条链路都是「前后端同源」，
  //    产物里必须烘焙 VITE_API_BASE_URL=/（App.tsx 会把末尾斜杠削掉，请求变成相对路径 /api/xxx）。
  //
  //    漏掉它 `vite build` 不报错、`wrangler deploy` 也成功，但线上登录直接报
  //    「未配置后端地址（部署时未能推导出 Worker 地址）」—— 整个站点等于挂了，
  //    而构建日志里一句异常都没有，只有肉眼打开页面才能发现。
  //    这个坑 2026-09-30 踩过一次；同日又踩了第二次：在 Git Bash 里手写
  //    `VITE_API_BASE_URL=/ npm run build`，MSYS2 把裸斜杠改写成了 Git 安装根目录，
  //    产物里被烘焙进 `C:/Users/.../PortableGit/1.2.0/`（比漏掉更难查）。
  //    所以这里把「静默坏掉」升级成「构建直接失败」。
  //    ⚠️ 两个来源都要看：.env 文件（自建链路）与进程环境变量（GitHub Actions 与 build-web.py）。
  const apiBase = env.VITE_API_BASE_URL || process.env.VITE_API_BASE_URL;
  if (!apiBase) {
    throw new Error(
      [
        "",
        "✖ 缺少 VITE_API_BASE_URL —— 产物会在线上报「未配置后端地址」，站点等于挂了。",
        "",
        "  正确做法（二选一，都不要在 Git Bash 里手写 `VAR=/` 前缀）：",
        "    · Cloudflare 链路：python dnshe-deploy/.apitmp/build-web.py",
        "    · 自建链路：      npm run build:selfhost   （读 .env.selfhost）",
        "",
        "  非要手工构建就带 MSYS_NO_PATHCONV=1，否则 MSYS2 会把 / 改写成本机路径：",
        "    MSYS_NO_PATHCONV=1 VITE_API_BASE_URL=/ npx vite build",
        "",
      ].join("\n")
    );
  }

  return {
    plugins: [react()],
    server: {
      port: 3000,
      proxy: {
        // 本地开发代理，将所有 /api 请求代理到正在运行的 wrangler dev 本地服务 (默认 8787 端口)
        "/api": {
          target: "http://127.0.0.1:8787",
          changeOrigin: true,
        },
      },
    },
  };
});
