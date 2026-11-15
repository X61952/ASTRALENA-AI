// Lexa answers ONE person. Recent WhatsApp versions may deliver a sender as a
// hidden "@lid" id instead of the phone number, so every id form on the
// message is checked, plus WhatsApp's own LID->phone mapping when available.
// In a group the sender is the PARTICIPANT, not the group; only the owner's own
// messages count there. Status, broadcast lists and channels are never answered.
const digitsOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const isPhoneJid = (jid) => /@s\.whatsapp\.net$/.test(jid || '');
const isLid = (jid) => /@lid$/.test(jid || '');

export async function isAllowedSender(key, allowedNumber, { lidToPhone, allowGroups = false } = {}) {
  if (!key || !allowedNumber) return false;
  const chat = key.remoteJid || '';
  if (/@broadcast$|@newsletter$/.test(chat)) return false;
  const inGroup = /@g\.us$/.test(chat);
  if (inGroup && !allowGroups) return false;
  const candidates = (inGroup ? [key.participant, key.participantAlt] : [key.remoteJid, key.remoteJidAlt, key.participant, key.participantAlt]).filter(Boolean);
  if (candidates.some((j) => /@g\.us$|@broadcast$|@newsletter$/.test(j))) return false;
  for (const jid of candidates) {
    if (isPhoneJid(jid) && digitsOf(jid) === allowedNumber) return true;
  }
  if (lidToPhone) {
    for (const jid of candidates.filter(isLid)) {
      try {
        const pn = await lidToPhone(jid);
        if (pn && digitsOf(pn) === allowedNumber) return true;
      } catch {}
    }
  }
  return false;
}
