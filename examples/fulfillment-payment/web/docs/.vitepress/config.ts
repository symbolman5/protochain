import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Protochain Project Review',
  description: '协议驱动自验证工具链 —— 项目级组合视图',
  cleanUrls: true,
  srcDir: '.',
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: '项目总览', link: '/' },
      { text: '子协议', link: '/protocols/' },
      { text: '跨协议引用', link: '/cross-refs' },
      { text: '跨协议 diff', link: '/cross-diff' },
    ],
    sidebar: [
      {
        text: '组合视图',
        items: [
          { text: '项目总览', link: '/' },
          { text: '子协议列表', link: '/protocols/' },
          { text: '跨协议引用矩阵', link: '/cross-refs' },
          { text: '跨协议 diff', link: '/cross-diff' },
        ],
      },
    ],
    socialIcons: [],
    footer: {
      message: '由 protochain derive-web --project 机械生成',
      copyright: 'Generated at ' + new Date().toISOString(),
    },
  },
});
