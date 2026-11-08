import { createComponent, defineComponents } from '@iwsdk/core';
import { FireEyeStatus } from './fire-eye-state.js';

export const BuildingModel = createComponent('BuildingModel', {});
export default defineComponents([BuildingModel, FireEyeStatus]);
