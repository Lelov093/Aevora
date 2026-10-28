/** Copy for the More menu rows: navigation actions, and Creator draft prompts per region. */
export const en = {
  install: 'Browse other plugins',
  create: 'Create your plugin',
  'createPrompt.sidebar': 'Create a Harness plugin with a left sidebar entry.',
  'createPrompt.conversation': 'Create a Harness conversation view plugin.',
  'createPrompt.rightbar': 'Create a Harness plugin with a right sidebar entry.',
} as const

/** Chinese counterpart of the entry-customization dictionary. */
export const zh: Record<keyof typeof en, string> = {
  install: '浏览更多插件',
  create: '创建你的插件',
  'createPrompt.sidebar': '创建一个带左侧栏入口的 Harness 插件。',
  'createPrompt.conversation': '创建一个 Harness 会话视图插件。',
  'createPrompt.rightbar': '创建一个带右侧栏入口的 Harness 插件。',
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'install': '他のプラグインを探す',
  'create': 'プラグインを作成',
  'createPrompt.sidebar': '左サイドバーにエントリを持つ Harness プラグインを作成します。',
  'createPrompt.conversation': 'Harness 会話ビュープラグインを作成します。',
  'createPrompt.rightbar': '右サイドバーにエントリを持つ Harness プラグインを作成します。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  install: 'Explorar otros complementos',
  create: 'Crea tu complemento',
  'createPrompt.sidebar': 'Cree un complemento Harness con una entrada en la barra lateral izquierda.',
  'createPrompt.conversation': 'Cree un complemento de vista de conversación Harness.',
  'createPrompt.rightbar': 'Cree un complemento Harness con una entrada en la barra lateral derecha.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  install: "Parcourir d'autres plugins",
  create: 'Créez votre plugin',
  'createPrompt.sidebar': 'Créez un plugin Harness avec une entrée dans la barre latérale gauche.',
  'createPrompt.conversation': "Créez un plugin d'affichage de conversation Harness.",
  'createPrompt.rightbar': 'Créez un plugin Harness avec une entrée dans la barre latérale droite.',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  install: 'Durchsuchen Sie andere Plugins',
  create: 'Erstellen Sie Ihr Plugin',
  'createPrompt.sidebar': 'Erstellen Sie ein Harness-Plugin mit einem Eintrag in der linken Seitenleiste.',
  'createPrompt.conversation': 'Erstellen Sie ein Harness-Plugin für die Konversationsansicht.',
  'createPrompt.rightbar': 'Erstellen Sie ein Harness-Plugin mit einem Eintrag in der rechten Seitenleiste.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  install: 'Просмотрите другие плагины',
  create: 'Создайте свой плагин',
  'createPrompt.sidebar': 'Создайте плагин Harness с записью на левой боковой панели.',
  'createPrompt.conversation': 'Создайте плагин просмотра диалога Harness.',
  'createPrompt.rightbar': 'Создайте плагин Harness с записью на правой боковой панели.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  install: 'Procure outros plug-ins',
  create: 'Crie seu plug-in',
  'createPrompt.sidebar': 'Crie um plug-in Harness com uma entrada na barra lateral esquerda.',
  'createPrompt.conversation': 'Crie um plug-in de visualização de conversa Harness.',
  'createPrompt.rightbar': 'Crie um plug-in Harness com uma entrada na barra lateral direita.',
} satisfies Record<keyof typeof en, string>
