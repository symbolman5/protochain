import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Protochain Review',
  description: '协议驱动自验证工具链 — 模型检阅界面',
  cleanUrls: true,
  srcDir: '.',
  ignoreDeadLinks: true,
  // 不启用搜索框的索引构建（保持构建轻量）
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '接口', link: '/interfaces/' },
      { text: '测试用例', link: '/test-cases' },
      { text: '验证报告', link: '/verification' },
      { text: 'diff/impact', link: '/diff' },
    ],
    sidebar: [
      {
        text: '接口',
        items: [{ text: '列表', link: '/interfaces/' }],
      },
      {
        text: '检阅',
        items: [
          { text: '测试用例', link: '/test-cases' },
          { text: '验证报告', link: '/verification' },
          { text: 'diff/impact', link: '/diff' },
        ],
      },
    ],
    socialIcons: [],
    footer: {
      message: '由 protochain derive-web 机械生成',
      copyright: 'Generated at ' + new Date().toISOString(),
    },
  },
});
