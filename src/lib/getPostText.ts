import type {CTAAlert} from './cta_types.js'

export default async function getPostText(alert_: CTAAlert) {
  // Generate the text for your post here. You can return a string or a promise that resolves to a string
  var text = `${alert_.ShortDescription}`;
  const emojis = 
    {
      red: "🟥",
      brown: "🟫",
      blue: "🟦",
      green: "🟩",
      purple: "🟪",
      orange: "🟧",
      pink: "🩷",
      yellow: "🟨",
      bus: "🚍"
    }
  
  text = text.trim();
  Object.keys(emojis).forEach((key) => {
    var re = new RegExp(`(${key}( and|, | line| &))`, "i");
    const emoji = emojis[key as keyof typeof emojis];
    text = text.replace(re, `${emoji} $1`)
  })
  if ( text.includes("buses") || text.includes("bus stop") ) {
    text = `${emojis.bus} ${text}`;
  }
  if (text.length > 300) {
    text = text.slice(0, 250) + '... ' + alert_.AlertURL['#cdata-section']
  }
  
  return text;
}
