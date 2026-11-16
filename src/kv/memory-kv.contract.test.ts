import { defineKvContract } from '../testing/index.js';
import { MemoryKv } from './memory-kv.js';

defineKvContract('MemoryKv', (seed) => new MemoryKv(seed));
