# 个人主页

一个零依赖的静态个人主页与 Markdown 博客。主页内容位于 `public/index.html`，
博客文章位于 `content/posts/`，构建时会生成 `/blog/`、文章详情页和 RSS。

头像使用仓库内的 `public/avatar.jpg`，其来源为：
<https://avatars.githubusercontent.com/u/282148007?v=4>。

## 本地运行

```bash
npm run dev
```

开发服务会先构建博客，再提供 `dist` 目录，并在 <http://127.0.0.1:4173> 打开。

## 写文章

在 `content/posts/` 新建一个 `.md` 文件。文件开头使用 frontmatter：

```md
---
title: "文章标题"
description: "一句话摘要"
date: 2026-09-14
slug: "article-slug"
tags: ["标签"]
---

正文从这里开始。
```

如果省略 frontmatter，系统会使用一级标题、文件修改日期和文件名生成默认信息。推荐保留 frontmatter，方便稳定控制标题、日期和摘要。

提交后，构建脚本会生成文章页面。`published: false` 或 `draft: true` 的文章不会被发布。

## 构建并预览生产文件

```bash
npm run build
npm run preview
```

构建会将 `public` 递归复制到 `dist`，并根据 `content/posts/` 生成博客页面、RSS 和预览所需的静态文件。

## 部署到 Vercel

可以将此项目推送到 Git 仓库，然后在 Vercel 中选择 **Add New Project**，
导入该仓库并部署。`vercel.json` 已配置构建命令和 `dist` 输出目录。

也可以在已安装并登录 Vercel CLI 的环境中，从项目目录运行：

```bash
vercel --prod
```

以上为部署步骤说明；仓库本身不会自动执行部署。

如果需要让 RSS 和 canonical URL 使用正式域名，可以在 Vercel 项目里添加 `SITE_URL` 环境变量，
例如 `https://your-domain.com`。