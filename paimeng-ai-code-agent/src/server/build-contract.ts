import 'server-only';
import { z } from 'zod';
import { type CodeGenType, isProjectCodeGenType, type ProjectCodeGenType } from '@/shared/contracts';

export const BUILD_DEPENDENCIES: Record<string, string> = {
  vue: '3.5.17', vite: '7.0.0', '@vitejs/plugin-vue': '6.0.0',
  'vue-router': '4.5.1', pinia: '3.0.3', axios: '1.11.0',
  'ant-design-vue': '4.2.6', typescript: '5.9.3', 'vue-tsc': '2.2.10', '@types/node': '22.15.32',
};

export const REACT_DEPENDENCIES: Record<string, string> = {
  react: '19.1.0', 'react-dom': '19.1.0', vite: '7.0.0', '@vitejs/plugin-react': '4.6.0',
  'react-router-dom': '7.6.3', axios: '1.11.0', antd: '5.26.5',
  typescript: '5.9.3', '@types/react': '19.1.8', '@types/react-dom': '19.1.6', '@types/node': '22.15.32',
};

const buildDependencies: Record<ProjectCodeGenType, Record<string, string>> = {
  vue_project: BUILD_DEPENDENCIES,
  react_project: REACT_DEPENDENCIES,
};

const requiredDependencies: Record<ProjectCodeGenType, string[]> = {
  vue_project: ['vue', 'vite', '@vitejs/plugin-vue'],
  react_project: ['react', 'react-dom', 'vite', '@vitejs/plugin-react'],
};

const stackNames: Record<ProjectCodeGenType, string> = { vue_project: 'Vue', react_project: 'React' };

export function allowedDependencies(type: CodeGenType) {
  if (!isProjectCodeGenType(type)) throw new Error('只有工程类型需要校验构建依赖');
  return buildDependencies[type];
}

const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

export function validateProjectManifest(type: ProjectCodeGenType, content: string) {
  const allowed = buildDependencies[type];
  const manifest = manifestSchema.parse(JSON.parse(content));
  for (const section of [manifest.dependencies, manifest.devDependencies]) {
    for (const [name, version] of Object.entries(section ?? {})) {
      if (!Object.hasOwn(allowed, name) || allowed[name] !== version) {
        throw new Error(`不允许的构建依赖 ${name}@${version}，请使用固定的允许版本。允许依赖 ${JSON.stringify(allowed)}`);
      }
    }
  }
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const missing = requiredDependencies[type].filter(name => !dependencies[name]);
  if (missing.length) throw new Error(`${stackNames[type]} 工程必须包含允许版本的构建依赖：${requiredDependencies[type].join('、')}`);
  return dependencies;
}
