import {api} from './api';
import {useResource,useApp} from './state';
import type {EntityKind,EffectiveDefinition} from './business-config';
export function useBusinessDefinition(kind:EntityKind){const {revision}=useApp();return useResource<EffectiveDefinition>(s=>api('/business-config/effective/'+kind,{signal:s}),[kind,revision]);}
