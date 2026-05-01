import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'spore.host',
  description: 'Ephemeral compute for researchers and data scientists.',
  lang: 'en-US',

  // Exclude legacy docs dirs and internal files from the build.
  // These are kept in the repo as source material to incorporate into
  // the new VitePress structure over time.
  srcExclude: [
    'user-guide/**',
    'guide/**',
    'features/**',
    'research/**',
    'AWS_ACCOUNT_STRUCTURE.md',
    'DNSSEC_CONFIGURATION.md',
    'gen/**',
  ],

  head: [
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { href: 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400;1,700&display=swap', rel: 'stylesheet' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
  ],

  themeConfig: {
    siteTitle: 'spore.host',
    logo: null,

    nav: [
      { text: 'Quick Start', link: '/quickstart' },
      { text: 'Guides', link: '/guides/' },
      { text: 'Tools', link: '/tools/' },
      { text: 'Reference', link: '/reference/' },
      { text: 'spore.host', link: 'https://spore.host', target: '_blank' },
    ],

    sidebar: {
      '/': [
        { text: 'Quick Start', link: '/quickstart' },
        { text: 'How It Works', link: '/how-it-works' },
      ],
      '/guides/': [
        {
          text: 'Getting Started',
          collapsed: false,
          items: [
            { text: 'Installation', link: '/guides/installation' },
            { text: 'Your First Instance', link: '/guides/first-instance' },
            { text: 'Python SDK', link: '/guides/python-sdk' },
            { text: 'Go Library', link: '/guides/go-library' },
          ]
        },
        {
          text: 'Compute',
          collapsed: false,
          items: [
            { text: 'GPU Training Jobs', link: '/guides/gpu-training' },
            { text: 'Jupyter Notebooks', link: '/guides/jupyter' },
            { text: 'Spot Instances', link: '/guides/spot-instances' },
          ]
        },
        {
          text: 'Automation & Control',
          collapsed: false,
          items: [
            { text: 'Slack Setup', link: '/guides/slack-setup' },
            { text: 'Self-Hosting', link: '/guides/self-hosting' },
            { text: 'Teams Setup', link: '/guides/teams-setup' },
            { text: 'AI Assistant (MCP)', link: '/guides/mcp-setup' },
            { text: 'Lifecycle Notifications', link: '/guides/notifications' },
          ]
        },
        {
          text: 'Advanced',
          collapsed: false,
          items: [
            { text: 'Parameter Sweeps', link: '/guides/parameter-sweeps' },
            { text: 'MPI Clusters', link: '/guides/mpi' },
            { text: 'Pipelines', link: '/guides/pipelines' },
            { text: 'Plugins', link: '/guides/plugins' },
            { text: 'Job Arrays', link: '/guides/job-arrays' },
          ]
        },
        {
          text: 'Self-Hosting',
          collapsed: true,
          items: [
            { text: 'Self-Hosting spore-bot', link: '/spore-bot-self-hosting' },
          ]
        },
      ],
      '/tools/': [
        {
          text: 'Tools',
          items: [
            { text: 'Overview', link: '/tools/' },
            { text: 'Truffle', link: '/tools/truffle' },
            { text: 'Spawn', link: '/tools/spawn' },
            { text: 'Lagotto', link: '/tools/lagotto' },
            { text: 'Spore-bot', link: '/tools/spore-bot' },
            { text: 'MCP Server', link: '/tools/mcp-server' },
          ]
        },
        {
          text: 'Command Reference',
          items: [
            { text: 'truffle', link: '/tools/reference/truffle' },
            { text: 'spawn', link: '/tools/reference/spawn' },
            { text: 'lagotto', link: '/tools/reference/lagotto' },
          ]
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'EC2 Tags', link: '/reference/ec2-tags' },
            { text: 'IAM Permissions', link: '/reference/iam-permissions' },
            { text: 'Lifecycle Events', link: '/reference/lifecycle-events' },
            { text: 'Environment Variables', link: '/reference/environment-variables' },
            { text: 'FAQ', link: '/reference/faq' },
            { text: 'Cheat Sheet', link: '/reference/cheatsheet' },
          ]
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/scttfrdmn/spore-host' },
    ],

    editLink: {
      pattern: 'https://github.com/scttfrdmn/spore-host/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the <a href="https://github.com/scttfrdmn/spore-host/blob/main/LICENSE">Apache 2.0 License</a>.',
      copyright: '© 2026 Scott Friedman',
    },

    search: {
      provider: 'local',
    },
  },
})
