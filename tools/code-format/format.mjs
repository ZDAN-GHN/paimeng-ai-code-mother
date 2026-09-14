import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import prettier from 'prettier'
import javaPlugin from 'prettier-plugin-java'
import { PositionEncoding, Workspace } from '@astral-sh/ruff-wasm-nodejs'

const root = path.resolve(import.meta.dirname, '../..')
const checkOnly = process.argv.includes('--check')
const ignoredDirectories = new Set(['node_modules', 'dist', 'target', 'coverage', '.git', '.venv', '__pycache__'])

const prettierOptions = {
  semi: false,
  singleQuote: true,
  printWidth: 100,
}

const pythonWorkspace = new Workspace(
  {
    'indent-width': 4,
    format: {
      'indent-style': 'space',
      'quote-style': 'double',
    },
  },
  PositionEncoding.Utf16,
)

async function collectFiles(directory, extensions) {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...(await collectFiles(file, extensions)))
    } else if (extensions.has(path.extname(entry.name))) {
      files.push(file)
    }
  }
  return files
}

function normalizeTypeMemberWhitespace(source) {
  const member = '(?:readonly\\s+)?[A-Za-z_$][\\w$]*(?:\\?)?\\s*:'
  const emptyLine = '\\n[\\t ]*\\n'
  const newline = String.fromCharCode(10)
  let output = source
  let previous
  do {
    previous = output
    output = output.replace(
      new RegExp(`(\\{)${emptyLine}(?=[\\t ]*${member})`, 'g'),
      (_, opening) => `${opening}${newline}`,
    )
    output = output.replace(
      new RegExp(`(${member}[^\\n]*)${emptyLine}(?=[\\t ]*${member})`, 'g'),
      (_, field) => `${field}${newline}`,
    )
    output = output.replace(
      new RegExp(`(${member}[^\\n]*)${emptyLine}(?=[\\t ]*\\})`, 'g'),
      (_, field) => `${field}${newline}`,
    )
  } while (output !== previous)
  return output
}

async function formatWithPrettier(files, parser, options = {}) {
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8')
    const input = parser === 'typescript' || parser === 'vue' ? normalizeTypeMemberWhitespace(source) : source
    const formatted = await prettier.format(input, {
      ...prettierOptions,
      parser,
      ...options,
    })
    if (source !== formatted) {
      if (checkOnly) {
        console.error(`Needs formatting: ${path.relative(root, file)}`)
        process.exitCode = 1
      } else {
        await fs.writeFile(file, formatted)
      }
    }
  }
}

async function formatPython(files) {
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8')
    const formatted = pythonWorkspace.format(source)
    if (source !== formatted) {
      if (checkOnly) {
        console.error(`Needs formatting: ${path.relative(root, file)}`)
        process.exitCode = 1
      } else {
        await fs.writeFile(file, formatted)
      }
    }
  }
}

const [javaFiles, agentFiles, frontendFiles, pythonFiles] = await Promise.all([
  collectFiles(path.join(root, 'paimeng-ai-code-backend/src'), new Set(['.java'])),
  collectFiles(path.join(root, 'paimeng-ai-code-agent'), new Set(['.ts'])),
  collectFiles(path.join(root, 'paimeng-ai-code-frontend'), new Set(['.ts', '.vue'])),
  collectFiles(path.join(root, 'paimeng-ai-code-rag'), new Set(['.py'])),
])

const frontendTypeScriptFiles = frontendFiles.filter((file) => path.extname(file) === '.ts')
const frontendVueFiles = frontendFiles.filter((file) => path.extname(file) === '.vue')

await formatWithPrettier(javaFiles, 'java', {
  plugins: [javaPlugin],
  tabWidth: 4,
  useTabs: false,
})
await formatWithPrettier(agentFiles, 'typescript')
await formatWithPrettier(frontendTypeScriptFiles, 'typescript')
await formatWithPrettier(frontendVueFiles, 'vue')
await formatPython(pythonFiles)

pythonWorkspace.free()

if (checkOnly && process.exitCode) process.exit(process.exitCode)
