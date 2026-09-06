# 个人主页

一个零依赖的静态个人主页。页面内容位于 `public/index.html`，样式位于
`public/styles.css`，亮暗主题逻辑位于 `public/theme.js`。

头像使用仓库内的 `public/avatar.jpg`，其来源为：
<https://avatars.githubusercontent.com/u/282148007?v=4>。

## 本地运行

```bash
npm run dev
```

开发服务默认使用 `public` 目录，并在 <http://127.0.0.1:4173> 打开。

构建并预览生产文件：

```bash
npm run build
npm run preview
```

构建会将 `public` 递归复制到 `dist`，预览命令只提供 `dist` 内的文件。

## 部署到 Vercel

可以将此项目推送到 Git 仓库，然后在 Vercel 中选择 **Add New Project**，
导入该仓库并部署。`vercel.json` 已配置构建命令和 `dist` 输出目录。

也可以在已安装并登录 Vercel CLI 的环境中，从项目目录运行：

```bash
vercel --prod
```

以上为部署步骤说明；仓库本身不会自动执行部署。
