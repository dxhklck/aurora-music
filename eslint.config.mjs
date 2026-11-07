import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

/**
 * ESLint 9 flat config。
 *
 * 定位是「typecheck 之外的第二道常规护栏」：typecheck 已经拦住类型错误与未使用的
 * 局部变量，ESLint 补的是 eqeqeq / no-constant-condition / 未捕获的重复声明这类
 * 类型系统管不到的问题。它拦不住「把 Vue 响应式对象直接喂给 IPC」这种运行时
 * 结构化克隆错误——那类坑靠 MEMORY 里的约定 + 代码审查防，别指望 linter。
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'dist-local/**',
      'resources/**',
      'artifacts/**',
      'scripts/engine-ts/.build/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' }
    }
  },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      // 未使用变量交给 typecheck 的 noUnusedLocals；这里只警告带 _ 前缀的豁免
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // IPC handler 的 payload 大量用 any，类型在 IPC 边界做运行时校验
      '@typescript-eslint/no-explicit-any': 'off',
      // 单字组件名（Icon.vue 等）是刻意为之
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
      // 纯 prettier 风格（本项目不用 prettier，格式交给编辑器手动）
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/attributes-order': 'off',
      // 刻意用控制字符 / 多字节字符匹配二进制与歌词，规则误报
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
      // defensive 初始化（let x = 0 后 try 覆盖）是常见写法，规则过激
      'no-useless-assignment': 'off',
      // catch 后抛新错误不强制带 cause
      'preserve-caught-error': 'off',
      // env.d.ts 的 {} 占位
      '@typescript-eslint/no-empty-object-type': 'off',
      // 字符串 / 注释里的全角空格是刻意内容（日志对齐、示例），只查真正的代码空白
      'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true, skipTemplates: true }],
      // catch 空块是常见兜底（如「已经断开」），别当 error
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'off',
      'no-constant-condition': ['error', { checkLoops: false }]
    }
  }
]
