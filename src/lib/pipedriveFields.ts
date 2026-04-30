export const PIPEDRIVE_FIELD_KEYS = {
  lastScrapedAt: '8f04861ac43f93cbb31f02478df92dd4cde3960a',
  scheduledEnrollment: 'aa97f61af684b32442cee6ec7842c18fdabc8045',
  shortGeo: '6ab83c83a757ae6dc43d95d73fca19e76272494f',
  longGeo: 'f39ffc033299b339f7e5dc5c8177b99bbec4b490',
  sequenceStarted: '48c4bb758e8642d6372c7fff9df3c0ea716170f1',
  senderSignature: '7d0c154f9cf320c0632eff8f37acb5b5e73a275b',
  projectStage: '7c1852c27664d1118f75660223a6af9e99d10f2c',
  projectAddress: '8315f83413b4d585f9d3009fbbfc054f1a82386b',
  launchSequence: 'ac01917c79bedd29218c9f980411b78a9dcea252',
  triggerAgc: '4e555902fff229d66c1a631ea2135e3676d710c4',
  triggerLba: '310a6cfbcf364587467a42835b369cd4bf1766fa',
  triggerCm: '5fd5cb8c79f7be331ae9af9b03285d9fe1756699',
  triggerPb: '61435d2e87311ced7c75007334828fa2de9e9628',
} as const;

export const PIPEDRIVE_TRIGGER_OPTION_IDS = {
  agc: 42,
  lba: 43,
  cm: 44,
  pb: 45,
} as const;

export const PIPEDRIVE_LAUNCH_SENDER_IDS = {
  derek: 48,
  michael: 49,
  josie: 50,
  terry: 51,
  auto: 52,
} as const;

export type PipedriveFieldKey = keyof typeof PIPEDRIVE_FIELD_KEYS;
