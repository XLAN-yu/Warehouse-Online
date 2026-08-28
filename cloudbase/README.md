# 仓储台 CloudBase 后端迁移包

目标环境：`warehouse-d0g4dqtmd88ca81c0`

本目录是从 Cloudflare D1 迁移到腾讯云 CloudBase 的后端基础。它不会影响当前的 Cloudflare 或 GitHub Pages 版本。

## 架构

- CloudBase 身份认证：邮箱和密码登录。
- `warehouse-api` 普通云函数：识别当前登录用户、初始化最高管理员和执行角色管理。
- CloudBase 文档型数据库：后续保存商品、供应商、库存单据、配方、系统设置和审计记录。

最高管理员初始邮箱由云函数环境变量 `WAREHOUSE_OWNER_EMAIL` 控制；默认值为 `1991412002@qq.com`。

## 首次部署

1. 在 CloudBase 控制台打开目标环境，进入 **云函数**，创建一个普通 Node.js 18 云函数，名称为 `warehouse-api`。
2. 将 `functions/warehouse-api` 内的文件打包为 ZIP（ZIP 根目录必须直接包含 `index.js` 和 `package.json`），上传并选择“保存并安装依赖”。
3. 在该函数的环境变量新增 `WAREHOUSE_OWNER_EMAIL=1991412002@qq.com`。该变量不含密钥。
4. 在 CloudBase 身份认证中保持“邮箱 + 密码”登录方式开启。
5. 在云函数安全设置中，只允许已登录用户调用该函数；不要开放匿名调用。

## 当前阶段

本次提交先完成身份与角色基础：首次由最高管理员邮箱登录时自动写入 `warehouse_users` 并设为 `owner`；其他登录者自动写入为 `pending`。最高管理员可调用 `set-role` 将用户设为 `admin`、`operator` 或 `viewer`。

下一阶段会将现有商品、入出库、盘点和配方动作迁到该函数，并以文档级数据和审计记录保存，完成后才切换网页请求地址。

不要在仓库或前端写入 CloudBase API Key、SecretId 或 SecretKey。普通云函数会以当前 CloudBase 环境身份访问数据库。
