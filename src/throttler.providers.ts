import { Provider } from '@nestjs/common';
import { ThrottlerModuleOptions } from './throttler-module-options.interface';
import { ThrottlerStorage } from './throttler-storage.interface';
import { THROTTLER_OPTIONS } from './throttler.constants';
import { ThrottlerStorageService } from './throttler.service';

export function createThrottlerProviders(options: ThrottlerModuleOptions): Provider[] {
  return [
    {
      provide: THROTTLER_OPTIONS,
      useValue: options,
    },
  ];
}

export const ThrottlerStorageProvider = {
  provide: ThrottlerStorage,
  useFactory: (options: ThrottlerModuleOptions) => {
    return options.storage ? options.storage : new ThrottlerStorageService();
  },
  inject: [THROTTLER_OPTIONS],
};
