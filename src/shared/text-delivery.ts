/** A partial paste must never be retried or represented as submitted. */
export type TextDeliveryResult = boolean | 'pasted-not-submitted'
export const TEXT_NOT_SUBMITTED = 'Text was pasted but not submitted. Do not resend it. Inspect the terminal and submit manually if appropriate.'
