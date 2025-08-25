import type {CTAAlert} from './cta_types.js'

export default async function getPostText(alert_: CTAAlert) {
  // Generate the text for your post here. You can return a string or a promise that resolves to a string
  var text = `${alert_.ShortDescription}`;
  for ( var i = 0; i < 128; i++) {
    text = text.replaceAll( `&#${i};`, String.fromCharCode(i) )
  }
  text = text.replaceAll(`  +`, ' ')
  text = text.replaceAll('\n', ' ')
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
  
  if (text.includes('🚆 Metra')) {
    var m = text.match(/(🚆 Metra [A-Z\-]+: )([A-Z\-]+) (.*)/)
    if (m !== null) {
        text = m[1] + m[3];
    }
  }
  
  if (text.length > 300) {
    if (text.includes('🚆 Metra')) {
        let text_blocks = text.split('. ')
        let t = text_blocks[0]
        let i = 1
        while (t.length + text_blocks[i].length + 2 < 300 || i == t.length) {
            t = t + '. ' + text_blocks[i]
            i = i + 1
        }
        text = t;
    } else {
        text = text.slice(0, 250) + '... ' + alert_.AlertURL['#cdata-section']
    }
  }

  return text;
}
