# 招聘工作台部署

这个分支对应测试端口 49613，服务器发布版本为 20261120-165448，数据库迁移版本为 27。deployment/runtime/ 保存发布目录的运行代码、迁移和当前页面引用的静态资源。文件哈希见 deployment/snapshot.json。

公开版本将硬编码的个人测试收件地址换成了示例地址。已有业务环境通过原有发布流程管理真实收件地址。不要用公开快照覆盖已运行的业务目录。

## 本地开发与 macOS 部署

使用 Node.js 22.19+、npm、PostgreSQL 17 和 Python 3。已有本地 V4 实例时，先核对端口和数据库再运行安装脚本。

    npm --prefix backend-v3 ci
    npm --prefix web ci
    npm --prefix backend-v3 run db:local
    npm run typecheck
    npm run build
    python3 backend-v3/scripts/install-runtime.py --plan

本地数据库脚本通过 Docker 使用回环地址的 55434 端口，首次启动生成私有数据库密码和应用密钥。应用参数参考 backend-v3/.env.example。用 RECRUIT_V4_LOCAL_ORIGIN 指定 macOS HTTPS 入口，并为对应域名配置受信任证书和飞书回调。安装脚本的 --prepare 生成待部署版本，随后用 --maintenance RELEASE_ID 和 --activate RELEASE_ID 切换。预览端口为 39613，两个 API 分别监听 39611、39612。切换后运行 npm run test:runtime 验证。

本机部署脚本会生成 LaunchAgent，工作目录为 ~/Library/Application Support/RecruitWorkbenchV4。

## 服务器运行快照

deployment/runtime 中的 package-lock.json 锁定 Node 依赖。可在隔离环境进入该目录执行 npm ci --omit=dev，通过私有环境变量提供 PostgreSQL、存储、HTTPS 和飞书配置，然后使用 node dist/index.js 启动 API。后台入口为 dist/worker-main.js，HTTPS 网关入口为 dist/gateway.js。正式和测试使用独立数据库、文件目录、会话 Cookie 和飞书回调。先验证迁移，再对实际入口检查 /health/ready。

仓库提供环境变量示例和部署脚本。真实环境文件、TLS 私钥、简历、数据库和日志由所在环境保管。
