import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js', 'lib/types/trace-producer-plugin.js'])
