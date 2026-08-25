/** Pinned ToolRet source files published by the benchmark authors. */

export const TOOL_RET_CATEGORIES = ['web', 'code', 'customized'] as const

export type ToolRetCategory = typeof TOOL_RET_CATEGORIES[number]
export type ToolRetSourceKind = 'tools' | 'queries'

export interface ToolRetSourceFile {
  kind: ToolRetSourceKind
  config: string
  path: string
  expectedBytes: number
  sha256: string
}

export const TOOL_RET_REPOSITORIES = {
  tools: {
    id: 'mangopy/ToolRet-Tools',
    revision: 'e06c38c75612b6536bd959e08cdd345894aba6a7',
  },
  queries: {
    id: 'mangopy/ToolRet-Queries',
    revision: 'b8c76ad3349ff17497b6bdb28bb5b8f61a0f6445',
  },
} as const

export const TOOL_RET_TOOL_SOURCES: readonly ToolRetSourceFile[] = [
  { kind: 'tools', config: 'code', path: 'code/tools-00000-of-00001.parquet', expectedBytes: 788678, sha256: 'a5b1a8111a40128b1429fe53a490e627fd2832ebe2e641db5eeb695ecb4f0d9a' },
  { kind: 'tools', config: 'customized', path: 'customized/tools-00000-of-00001.parquet', expectedBytes: 384413, sha256: 'e3d0cf64f5d5321751401677c820c5e8c7df79bfd67a85c01e275fe573cbde41' },
  { kind: 'tools', config: 'web', path: 'web/tools-00000-of-00001.parquet', expectedBytes: 8143446, sha256: '57faceebd778b2cb74571dca0e71e8bc8078c11ba05dce0efc562e818d3950e6' },
]

export const TOOL_RET_QUERY_SOURCES: readonly ToolRetSourceFile[] = [
  { kind: 'queries', config: 'apibank', path: 'apibank/queries-00000-of-00001.parquet', expectedBytes: 45023, sha256: '1e91b9c4f7e0b38946bf5c3272e15af73f0b446e4d546c52e09179b3a9709d3b' },
  { kind: 'queries', config: 'apigen', path: 'apigen/queries-00000-of-00001.parquet', expectedBytes: 352171, sha256: '7f6d6ee477ba98380816c418f51c445c937771ee557d73c0a575d0d30fd01a14' },
  { kind: 'queries', config: 'appbench', path: 'appbench/queries-00000-of-00001.parquet', expectedBytes: 29833, sha256: 'e7efff5e12a7676df46ded343abfdd44cc3c4fbeacee3d6b89edec8a9022b5d7' },
  { kind: 'queries', config: 'autotools-food', path: 'autotools-food/queries-00000-of-00001.parquet', expectedBytes: 88101, sha256: 'a780caf11c358db91552c6c75a7c8fe6312c73dcead3413543b9ccb1ffef6419' },
  { kind: 'queries', config: 'autotools-music', path: 'autotools-music/queries-00000-of-00001.parquet', expectedBytes: 1278393, sha256: 'aff4630b7e8828b262df047b2db1172cf24b57c15e454261359f6e64e028487d' },
  { kind: 'queries', config: 'autotools-weather', path: 'autotools-weather/queries-00000-of-00001.parquet', expectedBytes: 96147, sha256: '80203c8ee6070ca102b08eb90b134f9602e4d085ba2f4da4f89288e1edd5f68f' },
  { kind: 'queries', config: 'craft-math-algebra', path: 'craft-math-algebra/queries-00000-of-00001.parquet', expectedBytes: 145294, sha256: '70993dcb4bc2b55f42994bed7f08b785d6af6baad941ee6973db26e2700b5df6' },
  { kind: 'queries', config: 'craft-tabmwp', path: 'craft-tabmwp/queries-00000-of-00001.parquet', expectedBytes: 93220, sha256: 'c86458e41e26ac631aea4223fb9e24803d1b8117e31c28265824c10d221cfdf5' },
  { kind: 'queries', config: 'craft-vqa', path: 'craft-vqa/queries-00000-of-00001.parquet', expectedBytes: 85397, sha256: '014a4d68f6f55f74820139ea6008cbce91c609d8e0965aac94ac1599683d8d9b' },
  { kind: 'queries', config: 'gorilla-huggingface', path: 'gorilla-huggingface/queries-00000-of-00001.parquet', expectedBytes: 290310, sha256: 'ed64800b722bc8e2b8520feb3e5defc3988b0cc858929396ffc930625e71f703' },
  { kind: 'queries', config: 'gorilla-pytorch', path: 'gorilla-pytorch/queries-00000-of-00001.parquet', expectedBytes: 33422, sha256: 'b6423e142bab08ac0d7f9cdc1851a8e85a915970936139c795f697188b137ae0' },
  { kind: 'queries', config: 'gorilla-tensor', path: 'gorilla-tensor/queries-00000-of-00001.parquet', expectedBytes: 24985, sha256: '5b037823ac75e503df7abb08c51dcf7843f86ffb8ff45a625a09f1589b8f1fc7' },
  { kind: 'queries', config: 'gpt4tools', path: 'gpt4tools/queries-00000-of-00001.parquet', expectedBytes: 20023, sha256: '7171ba30b7930b76e3562d38c0cf74c2c778fbc429e2087234f8bef577ed7576' },
  { kind: 'queries', config: 'gta', path: 'gta/queries-00000-of-00001.parquet', expectedBytes: 18173, sha256: '757560b5e587993e8fb05c9d3ad146016cdefa21b938bd50b78ad6045067bb08' },
  { kind: 'queries', config: 'metatool', path: 'metatool/queries-00000-of-00001.parquet', expectedBytes: 59240, sha256: 'f4839301cd345a6b5eef1ebfd1710dfb209e5c9b6812a31ed8d7152979393ca0' },
  { kind: 'queries', config: 'mnms', path: 'mnms/queries-00000-of-00001.parquet', expectedBytes: 20327, sha256: 'd591f2cf3974abe21c6c0462a935b53b807246b95ed4d7439d5d05e0e97973ca' },
  { kind: 'queries', config: 'restgpt-spotify', path: 'restgpt-spotify/queries-00000-of-00001.parquet', expectedBytes: 212315, sha256: 'a2dcd32971d6e807c437f09f3c09f84a2bc53a805468b98307ea41116c35e0a4' },
  { kind: 'queries', config: 'restgpt-tmdb', path: 'restgpt-tmdb/queries-00000-of-00001.parquet', expectedBytes: 693183, sha256: 'aa8a256d7100b005f6258f60229b5c0350967be3b8b8d6e6b58dfa79a8059193' },
  { kind: 'queries', config: 'reversechain', path: 'reversechain/queries-00000-of-00001.parquet', expectedBytes: 100619, sha256: 'd4da51689cfc10f045e37bce6ffeb665e43a67faa9d71834abc84106603ad854' },
  { kind: 'queries', config: 'rotbench', path: 'rotbench/queries-00000-of-00001.parquet', expectedBytes: 92990, sha256: '2f75a1caf9c105560b5da02bd17e733e7d4d7e57ed6e0696728ffc36dae00159' },
  { kind: 'queries', config: 't-eval-dialog', path: 't-eval-dialog/queries-00000-of-00001.parquet', expectedBytes: 49204, sha256: 'da566b97d930ce44b89bca85c2e7fa6acac6809110f76bb2e354a77a978ed97e' },
  { kind: 'queries', config: 't-eval-step', path: 't-eval-step/queries-00000-of-00001.parquet', expectedBytes: 49745, sha256: 'eddd81571593a320e09b96d3807350d81f5c2778087489844d73551fca14c899' },
  { kind: 'queries', config: 'taskbench-daily', path: 'taskbench-daily/queries-00000-of-00001.parquet', expectedBytes: 22675, sha256: '7357298960afafd3afcff91559cc14e95486e729798ef1b39af044e494cb8d15' },
  { kind: 'queries', config: 'taskbench-huggingface', path: 'taskbench-huggingface/queries-00000-of-00001.parquet', expectedBytes: 19567, sha256: 'c94f6ca056dd0906fb0f0d2cd9abe4f98a077c368fc52af9dee14325ee60d58a' },
  { kind: 'queries', config: 'taskbench-multimedia', path: 'taskbench-multimedia/queries-00000-of-00001.parquet', expectedBytes: 23044, sha256: '0cebfcd50a061c48c043785f80db4ec48fbaa82f764db29f20b83f82b7e6d7e4' },
  { kind: 'queries', config: 'tool-be-honest', path: 'tool-be-honest/queries-00000-of-00001.parquet', expectedBytes: 166352, sha256: 'e936b9dde7b3e7256662464a118b952c3873ea0b6086d0a328a568b7b35678cb' },
  { kind: 'queries', config: 'toolace', path: 'toolace/queries-00000-of-00001.parquet', expectedBytes: 618326, sha256: '49f7c861cec1799430680cea1df6cb98a10b33227f6cb183ac32375f396fcd5a' },
  { kind: 'queries', config: 'toolalpaca', path: 'toolalpaca/queries-00000-of-00001.parquet', expectedBytes: 36261, sha256: '627659a13d1b30a76e94d91ea27b14b4bc3be30e3fd6cd727f58ca1665bb1fe2' },
  { kind: 'queries', config: 'toolbench-sam', path: 'toolbench-sam/queries-00000-of-00001.parquet', expectedBytes: 50343, sha256: '36075db0985db103afac9ad959f7974e79eb267c7d47fd31a6de4813e3a3802f' },
  { kind: 'queries', config: 'toolbench', path: 'toolbench/queries-00000-of-00001.parquet', expectedBytes: 922485, sha256: '2bb32ea009d6ece37b1b785330247aacac037a20dd4522632cb3359809c8837d' },
  { kind: 'queries', config: 'toolemu', path: 'toolemu/queries-00000-of-00001.parquet', expectedBytes: 93924, sha256: 'f11491359b61bfb4a6f4d9bed2c45baab547938986e749e9eee555c667887020' },
  { kind: 'queries', config: 'tooleyes', path: 'tooleyes/queries-00000-of-00001.parquet', expectedBytes: 34642, sha256: 'c28280ed0a3cb119cc22f3f6678610bd2b7d4f9acbe7b800f0452b9a8d8a5d09' },
  { kind: 'queries', config: 'toolink', path: 'toolink/queries-00000-of-00001.parquet', expectedBytes: 114950, sha256: '6ff2d524e1e79b8af96518e9d880ddf00cb8371e1bf58475011551b74d9d4a91' },
  { kind: 'queries', config: 'toollens', path: 'toollens/queries-00000-of-00001.parquet', expectedBytes: 230860, sha256: '344e08a552508c77cb58e87dc93f7090f5c4eedba771095e5cdf6c1b12243a79' },
  { kind: 'queries', config: 'ultratool', path: 'ultratool/queries-00000-of-00001.parquet', expectedBytes: 134582, sha256: '5fc5fd59cab9e9a6852817ccb4645f81d47bf4394da232404d798c1be33d36b8' },
]

export const TOOL_RET_SOURCES: readonly ToolRetSourceFile[] = [
  ...TOOL_RET_TOOL_SOURCES,
  ...TOOL_RET_QUERY_SOURCES,
]

export function sourceRepository(source: ToolRetSourceFile): (typeof TOOL_RET_REPOSITORIES)[ToolRetSourceKind] {
  return TOOL_RET_REPOSITORIES[source.kind]
}

export function sourceUrl(source: ToolRetSourceFile): string {
  const repository = sourceRepository(source)
  return `https://huggingface.co/datasets/${repository.id}/resolve/${repository.revision}/${source.path}?download=true`
}
