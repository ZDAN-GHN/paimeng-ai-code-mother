import 'server-only';
import { z } from 'zod';

export const BUILD_DEPENDENCIES: Record<string, string> = {
  vue: '3.5.17', vite: '7.0.0', '@vitejs/plugin-vue': '6.0.0',
  'vue-router': '4.5.1', pinia: '3.0.3', axios: '1.11.0',
  'ant-design-vue': '4.2.6', typescript: '5.9.3', 'vue-tsc': '2.2.10', '@types/node': '22.15.32',
};

const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

export function validateVueManifest(content: string) {
  const manifest = manifestSchema.parse(JSON.parse(content));
  for (const section of [manifest.dependencies, manifest.devDependencies]) {
    for (const [name, version] of Object.entries(section ?? {})) {
      if (!Object.hasOwn(BUILD_DEPENDENCIES, name) || BUILD_DEPENDENCIES[name] !== version) {
        throw new Error(`不允许的构建依赖 ${name}@${version}，请使用固定的允许版本。允许依赖 ${JSON.stringify(BUILD_DEPENDENCIES)}`);
      }
    }
  }
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  if (!dependencies.vue || !dependencies.vite || !dependencies['@vitejs/plugin-vue']) throw new Error('Vue 工程必须包含允许版本的 Vue、Vite 和 Vue 插件');
  return dependencies;
}
