import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from './app.module';
import { VideoProcessingModule } from './videos/processing/video-processing.module';
import { VideoProcessingProcessor } from './videos/processing/video-processing.processor';
import { WorkerModule } from './worker.module';

type ModuleClass = new () => object;

function modulesOf(root: ModuleClass): ModuleClass[] {
  const found = new Set<ModuleClass>();
  const visit = (candidate: unknown) => {
    const module = (
      typeof candidate === 'function'
        ? candidate
        : (candidate as { module?: ModuleClass })?.module
    ) as ModuleClass | undefined;
    if (!module || found.has(module)) return;
    found.add(module);
    const imports =
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) ?? ([] as unknown[]);
    for (const imported of imports) visit(imported);
  };
  visit(root);
  return [...found];
}

const metadataOf = (root: ModuleClass, key: string): unknown[] =>
  modulesOf(root).flatMap((module) => Reflect.getMetadata(key, module) ?? []);

describe('WorkerModule', () => {
  it('should register the processor and no HTTP controller', () => {
    expect(metadataOf(WorkerModule, MODULE_METADATA.PROVIDERS)).toContain(
      VideoProcessingProcessor,
    );
    expect(metadataOf(WorkerModule, MODULE_METADATA.CONTROLLERS)).toEqual([]);
  });

  it('should be the only root that consumes the queue', () => {
    expect(modulesOf(AppModule)).not.toContain(VideoProcessingModule);
  });
});
