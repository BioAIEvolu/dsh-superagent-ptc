import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const pkg = JSON.parse(read('package.json'))
const patch = read('cordis.patch.yml')
const lines = patch.split(/\r?\n/)
const count = (needle) => patch.split(needle).length - 1

test('package identity, exports, files, and DSH engine match the build contract', () => {
  assert.equal(pkg.name, 'dsh-superagent-ptc')
  assert.equal(pkg.version, '0.1.1')
  assert.equal(pkg.private, undefined)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.main, './lib/host.mjs')
  assert.deepEqual(pkg.exports, {
    '.': './lib/host.mjs',
    './host': './lib/host.mjs',
    './client': './lib/client.js',
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json',
  })
  for (const file of ['lib/host.mjs', 'lib/client.js', 'cordis.patch.yml', 'LICENSE', 'NOTICE.md', 'README.md', 'docs']) {
    assert.ok(pkg.files.includes(file), 'missing packaged file: ' + file)
  }
  assert.ok(read('README.md').startsWith('# SuperAgent PTC\n'))
  assert.ok(read('docs/ARCHITECTURE.md').startsWith('# SuperAgent PTC 架构\n'))
  assert.ok(read('docs/VERIFICATION.md').startsWith('# SuperAgent PTC 验证记录\n'))
  assert.equal(pkg.engines.dsh, '>=0.2.2-rc.3 <0.3.0-0')
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(pkg.dsh.client, {
    platform: 'web',
    external: ['react'],
    inject: [
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-sidebar-right',
      '@deepseek-ai/dsh-client-ui-subagent',
    ],
  })
  assert.equal(pkg.icon, undefined)
  assert.equal(pkg.scripts.build, 'tsdown && node scripts/build-client.mjs')
  assert.match(pkg.scripts.test, /node --test/)
})

test('runtime, peer, and development dependencies match real host/client imports', () => {
  assert.deepEqual(pkg.dependencies, { zod: '4.6.6' })
  const range = '>=0.2.2-rc.3 <0.3.0-0'
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'], range)
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-session'], range)
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-storage-domain'], range)
  assert.equal(pkg.peerDependencies.react, '^18.2.0')

  const pinned = [
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-team',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-client-ui-subagent',
    '@deepseek-ai/dsh-goal',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-query',
    '@deepseek-ai/dsh-storage-domain',
    '@deepseek-ai/dsh-subagent',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
  ]
  for (const name of pinned) assert.equal(pkg.devDependencies[name], '0.2.2-rc.5', name)
  for (const [name, version] of Object.entries(pkg.devDependencies)) {
    if (name.startsWith('@deepseek-ai/') && name !== '@deepseek-ai/cordis') {
      assert.equal(version, '0.2.2-rc.5', 'development dependency not pinned to rc.5: ' + name)
    }
  }
  assert.equal(pkg.devDependencies['@deepseek-ai/cordis'], '^4.0.4')
  assert.equal(pkg.devDependencies['@types/react'], '^18.3.12')
  assert.equal(pkg.devDependencies.react, '^18.3.1')
  assert.equal(pkg.devDependencies.esbuild, '^0.25.0')
  assert.equal(pkg.devDependencies['react-dom'], undefined)
  assert.equal(pkg.devDependencies['@types/react-dom'], undefined)
  assert.equal(pkg.devDependencies['@deepseek-ai/dsh-client-ui-slots'], undefined)
})

test('default test script covers core, preset, host, and client suites', () => {
  for (const pattern of [
    'test/core/*.test.ts',
    'test/preset/*.test.mjs',
    'test/host/*.test.ts',
    'test/client/*.test.ts',
    'test/client/*.test.mjs',
  ]) {
    assert.ok(pkg.scripts.test.includes(pattern), 'missing default test coverage: ' + pattern)
  }
})

test('one declaration registers only the super-agent preset', () => {
  assert.equal(lines.filter((line) => line === '- insert:').length, 1)
  assert.equal(count("name: '@deepseek-ai/dsh-agent-preset'"), 1)
  assert.equal(count('id: preset-super-agent'), 1)
  assert.equal(lines.filter((line) => line === '        id: super-agent').length, 1)
  assert.equal(count('order: 5'), 1)
  assert.ok(patch.includes('name: SuperAgent PTC 模式'))
  assert.match(patch, /description: .*PTC\+.*目标锚点.*委派.*独立验收.*证据放行/)
  assert.doesNotMatch(patch, /^\s*icon:/m)
})

test('the current PTC executor is direct and the deprecated wrapper is absent', () => {
  assert.match(patch, /- id: tool-executor-ptc\r?\n\s+name: '@deepseek-ai\/dsh-tool-executor-ptc'/)
  assert.ok(!patch.includes('@deepseek-ai/dsh-agent-tool-presentation'))
  assert.ok(!patch.includes('id: tool-presentation'))
  assert.ok(!patch.includes('mode: ptc'))
})

test('the preset retains the official coding, goal, delegation, and support tools', () => {
  const required = [
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-time-context',
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-pwsh',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-tool-schedule',
    '@deepseek-ai/dsh-skill-filesystem',
    '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-command-goal',
    '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-plan-mode',
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-command-compact',
    '@deepseek-ai/dsh-compaction-tool-result-pruner',
    '@deepseek-ai/dsh-tool-subagent-control',
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-tool-ask-user',
    '@deepseek-ai/dsh-tool-todo',
    '@deepseek-ai/dsh-tool-web',
    '@deepseek-ai/dsh-tool-executor-ptc',
    '@deepseek-ai/dsh-tool-present',
    '@deepseek-ai/dsh-tool-office',
  ]
  for (const name of required) {
    assert.ok(patch.includes("name: '" + name + "'"), 'missing plugin: ' + name)
  }
  assert.equal(count("name: '@deepseek-ai/dsh-tool-subagent'"), 2)
  assert.ok(patch.includes('provider: spawn'))
  assert.ok(patch.includes('provider: fork'))
  assert.ok(patch.includes('modelSelection: true'))
  assert.ok(patch.includes('modelDiscovery: true'))
  assert.ok(patch.includes('interrupt: false'))
  assert.ok(patch.includes('allowedAgentPresets: [super-agent, standard]'))
})

test('one global bare host row enables client discovery without a preset-nested duplicate', () => {
  assert.equal(count('name: dsh-superagent-ptc'), 1)
  assert.equal(count('name: dsh-super-agent-mode/host'), 0)
  const hostId = lines.indexOf('    - id: super-agent-host-global')
  const presetId = lines.indexOf('    - id: preset-super-agent')
  assert.ok(hostId >= 0 && hostId < presetId, 'global host row must be a sibling before the preset definition')
  assert.equal(lines[hostId + 1], '      name: dsh-superagent-ptc')
  assert.equal(lines.indexOf('          - id: super-agent-host'), -1)
  assert.equal(pkg.main, './lib/host.mjs')
  assert.equal(pkg.exports['./host'], './lib/host.mjs')
})

test('rename preserves durable storage, proof, RPC, and right-sidebar identifiers', () => {
  assert.ok(read('src/host/storage.ts').includes('SUPER_AGENT_STORAGE_NAME = "super_agent_mode"'))
  assert.ok(read('src/host/proof.ts').includes('SNAPSHOT_PROOF_RECORD = "plugin:dsh-super-agent-mode/proof"'))
  assert.ok(read('src/host/proof.ts').includes('"plugin:dsh-super-agent-mode/proof": SnapshotProof'))

  const wire = read('src/shared/wire.ts')
  assert.ok(wire.includes('SUPER_AGENT_NAMESPACE = "dsh-super-agent-mode"'))
  assert.ok(wire.includes('SUPER_AGENT_ENDPOINTS = ["projection"]'))

  const client = read('src/client/index.ts')
  assert.ok(client.includes("const TAB_ID = 'dsh-super-agent-mode'"))
  assert.ok(client.includes("const TAB_KIND = 'super-agent'"))
  // 2026-11-20 user decision: the composer dock entry was removed by the user, so this dock id must stay absent.
  assert.ok(!client.includes("id: 'dsh-super-agent-mode-dock'"))
  assert.ok(client.includes("style.setAttribute('data-plugin', 'dsh-superagent-ptc')"))
  assert.ok(client.includes("title: () => 'SuperAgent PTC'"))
  assert.ok(read('src/host/index.ts').includes('export const name = "dsh-superagent-ptc-host"'))
})

test('persona carries roles, anchors, Mandate, evidence gates, budgets, and corrections', () => {
  const required = [
    'Lead、Worker、Reviewer',
    '主 Agent 不直接实现',
    '版本锚点',
    '未撤回的开放义务必须保留',
    'Mandate',
    'Reviewer 必须独立于 Worker',
    'pass / fail / unknown',
    '独立验收',
    '失败预算',
    '最新用户纠正',
    '无证据不放行',
    '不是全局文件权限沙箱',
    'team_task、list_agents、send_message、wait_agent',
    'Teams 未启用',
    '原生 subagent + Mandate/native IDs',
    'unknown 或 未受控',
    'Worker 默认继承 super-agent PTC',
    '省略 agent_preset',
    "agent_preset: 'standard'",
  ]
  for (const text of required) assert.ok(patch.includes(text), 'missing persona rule: ' + text)
  assert.ok(!patch.includes('spawn_teammate'), 'legacy Team API must not be presented as current')
  assert.ok(!patch.includes('agentPreset'), 'model-side preset selection must use agent_preset')
})

test('host ESM and wrapped CJS client builds target the declared outputs', () => {
  const config = read('tsdown.config.ts')
  assert.ok(config.includes("entry: { host: 'src/host/index.ts' }"))
  assert.ok(!config.includes("entry: { client:"))
  assert.equal((config.match(/outDir: 'lib'/g) || []).length, 1)

  const client = read('scripts/build-client.mjs')
  for (const contract of [
    "entryPoints: ['src/client/index.ts']",
    "outfile: 'lib/client.js'",
    "format: 'cjs'",
    "external: ['react']",
    'window.__ModuleLoader__.load',
    'id:"dsh-superagent-ptc"',
    ';return module.exports;}});',
  ]) {
    assert.ok(client.includes(contract), 'missing client build contract: ' + contract)
  }

  const tsconfig = JSON.parse(read('tsconfig.json'))
  assert.equal(tsconfig.compilerOptions.noEmit, true)
  assert.ok(tsconfig.include.includes('src/**/*.ts'))
  assert.ok(tsconfig.include.includes('src/**/*.tsx'))
})

test('MIT license and upstream NOTICE provenance are retained', () => {
  const license = read('LICENSE')
  const notice = read('NOTICE.md')
  assert.ok(license.includes('MIT License'))
  assert.ok(notice.includes('https://github.com/zouyuanqing/dsh-super-ptc-mode'))
  assert.ok(notice.includes('Copyright (c) 2026 zouyuanqing'))
  assert.ok(notice.includes('License: MIT'))
  assert.ok(notice.includes('Permission is hereby granted'))
  assert.ok(notice.includes('cordis.patch.yml'))
  assert.ok(notice.includes('LICENSE'))
  assert.ok(notice.includes('@khorsheed/dsh-taskpilot'))
  assert.ok(notice.includes('dsh-codeflow'))
  assert.ok(notice.includes('No TaskPilot implementation is copied.'))
  assert.ok(notice.includes('`dsh-superagent-ptc`'))
  assert.ok(notice.includes('original `dsh-super-agent-mode` implementation'))
  assert.ok(notice.includes('plugin:dsh-super-agent-mode/proof'))
  assert.ok(notice.includes('dsh-super-agent-mode/projection'))
})
