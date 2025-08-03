import axios from "axios";
import admin from 'firebase-admin';

import { bskyAccount, bskyService, firebaseServiceAccount, metraAccount } from "./config.js";
import type {
  CTAData, CTAAlert, MetraData, MetraAlert
} from "./cta_types.js"
import getDeltaT from "./getDeltaT.js";
import moment from 'moment-timezone';

import crypto from "crypto"

import type {
  AtpAgentLoginOpts,
  AtpAgentOpts,
  AppBskyFeedPost,
} from "@atproto/api";
import atproto from "@atproto/api";
const { BskyAgent, RichText } = atproto;

admin.initializeApp({
  credential: admin.credential.cert(firebaseServiceAccount)
});
const db = admin.firestore();

async function addData(parameter: number, headline: string, shortText: string, eventStart: string, agency: string) {
  try {
    const docRef = await db.collection('alerts').doc(String(parameter)).set({
      id: parameter,
      headline: headline,
      shortText: shortText,
      eventStart: admin.firestore.Timestamp.fromDate( new Date(
        moment.tz(eventStart, "America/Chicago").format()
      )),
      created: admin.firestore.Timestamp.now(),
      agency: agency
    });
    console.log('Document written with ID: ', parameter);
  } catch (e) {
    console.error('Error adding document: ', e);
  }
}

async function getMax(agency: string) {
  const alertsRef = db.collection('alerts');
  try {
    const docRef = (await 
        alertsRef.where('agency', '==', agency).orderBy("id", "desc").limit(1).get()
    ).docs[0];
    if (docRef == undefined) return 0;
    console.log('Document retrieved with ID: ', docRef.id);
    return parseInt(docRef.id);
  } catch (e) {
    console.error('Error getting document: ', e);
    return 999999999;
  }
}

async function getHash(): Promise<string> {
    const alertsRef = db.collection('alerts-fulltext-hash');
    try {
      const doc = (await 
          alertsRef.doc('hash').get()
      )
      if (doc == undefined || doc.data() == undefined) return '';
      let data = doc.data()
      console.log('Document retrieved with ID: ', doc.id);
      console.log('data is', data)
      return (data || {hash: ''} ).hash
    } catch (e) {
      console.error('Error getting document: ', e);
      return '';
    }
}

async function putHash(hash: string): Promise<string> {
    const alertsRef = db.collection('alerts-fulltext-hash');
    try {
      const doc = (await 
          alertsRef.doc('hash').set({hash: hash})
      )
      return 'ok'
    } catch (e) {
      console.error('Error setting document: ', e);
      return 'not ok';
    }
}
type BotOptions = {
  service: string | URL;
  parameter: number; 
  dryRun: boolean;
};

export default class Bot {
  #agent;

  static defaultOptions: BotOptions = {
    service: bskyService,
    parameter: 999,
    dryRun: false,
  } as const;

  constructor(service: AtpAgentOpts["service"]) {
    this.#agent = new BskyAgent({ service });
  }

  login(loginOpts: AtpAgentLoginOpts) {
    return this.#agent.login(loginOpts);
  }

  async post(
    text:
      | string
      | (Partial<AppBskyFeedPost.Record> &
          Omit<AppBskyFeedPost.Record, "createdAt">)
  ) {
    if (typeof text === "string") {
      const richText = new RichText({ text });
      await richText.detectFacets(this.#agent);
      const record = {
        text: richText.text,
        facets: richText.facets,
      };
      var output;
      try {
          output = this.#agent.post(record);
      } catch {
          console.log("ERROR: in try/catch block");
          console.log("Erroring post text:");
          console.log(record.text);
          output = new Promise( (res: Function, rej: Function) => {} );
      }
      return output;
    } else {
      return this.#agent.post(text);
    }
  }

  static async run(
    getPostText: (a: CTAAlert) => Promise<string>,
    botOptions?: Partial<BotOptions>
  ) {
    const cta_parameter = await getMax('cta');
    const metra_parameter = await getMax('metra');
    const hashvals = await getHash(); 
    console.log('cta_parameter returned is', cta_parameter)
    console.log('metra_parameter returned is', metra_parameter)
    const { service, dryRun /*, parameter */} = botOptions
      ? Object.assign({}, this.defaultOptions, botOptions)
      : this.defaultOptions;
    const bot = new Bot(service);
    await bot.login(bskyAccount);
    let alerts = (
      await 
        axios.get<CTAData>(
        'http://www.transitchicago.com/api/1.0/alerts.aspx?outputType=JSON&accessibility=FALSE&activeonly=TRUE')
    ).data.CTAAlerts.Alert;
    
    alerts = alerts.map (a => {
        let b = a;
        b.Agency = 'cta';
        return b;
    })

    let metra_alerts = (
        await axios.get<Array<MetraData>>('https://gtfsapi.metrarail.com/gtfs/alerts',
            { auth: metraAccount }
        )
    ).data

    const regex = /reminder|reopen|elevator|extra service|pedestrian crossing to close|tracks.*out of service|temporary.*platform.*will move/i ;
    
    // artificial debugging, shows what failed
    console.log('\n\nregex match, excluded\n')
    console.log(metra_alerts
        // true if matches exclusion words
        .filter( x => regex.test(x.alert.header_text.translation[0].text) )
        .map(x => x.alert.header_text.translation[0].text))
    
    metra_alerts = metra_alerts.filter(
        x => {
            let if_matches_exclusions = regex.test(x.alert.header_text.translation[0].text)
            return (! if_matches_exclusions)
        }
    )
    console.log('\n\nremaining\n')
    console.log(metra_alerts
        .map(x => [x.alert.header_text.translation[0].text,  regex.test(x.alert.header_text.translation[0].text)])
    )
    metra_alerts.sort((a,b) => 
        parseInt(a.id.replace(/[^0-9]/, '')) - parseInt(b.id.replace(/[^0-9]/, ''))
    );
    let rt_regex = /[A-Z][A-Z]-?[A-Z]?/g
    var alert_texts: Array<{id: string, text: string}> = []
    for (var i=0; i < metra_alerts.length; i++) {
        var headline = metra_alerts[i].alert.header_text.translation[0].text 
        var matches = headline.match(rt_regex)
        var route = ''
        if ( matches !== null )  route = matches[0];
        var descr =   metra_alerts[i].alert.description_text.translation[0].text.trim()
        if ( descr.length == 0 ) {
            descr = metra_alerts[i].alert.header_text.translation[0].text.trim()
        }
        var rt_pair = route
        var affected_route = null;
        if (rt_pair !== null ) {
            affected_route = metra_alerts[i].alert.informed_entity[0].route_id;
        }
        if (affected_route !== null ) {
            descr = descr.replaceAll(/\<[^>]*\>/g,'').split('&nbsp;').filter(x => x.length > 0)[0]
            var full_text = `🚆 Metra${affected_route == undefined ? '' : ' ' + affected_route}: ${descr}`
            alert_texts.push({id: metra_alerts[i].id, text: full_text})
        }
    }
   
    metra_alerts.map(
        alert => {
            var full_text_items = alert_texts.filter( x => x.id == alert.id);
            var full_text = '';
            if (full_text_items.length > 0) {
                full_text = full_text_items[0].text

                alerts.push( {
                    Agency: 'metra',
                    AlertId: alert.id.replaceAll(/[^0-9]/g, ''),
                    Headline: alert.alert.header_text.translation[0].text,
                    ShortDescription: full_text,
                    FullDescription: {['#cdata-section']: full_text},
                    SeverityColor: '',
                    SeverityScore: '',
                    SeverityCSS: '',
                    Impact: '',
                    EventStart: alert.alert.active_period.length ? alert.alert.active_period[0].start.low : (new Date()).toISOString(),
                    EventEnd: alert.alert.active_period.length ? alert.alert.active_period[0].end.low : (new Date()).toISOString(),
                    TBD: '',
                    MajorAlert: '',
                    AlertURL: {['#cdata-section']: alert.alert.url.translation[0].text},
                    ImpactedService: {Service: []},
                    ttim: '',
                    GUID: ''
                })
            }
        }
    )

    // sort ascending by id 
    
    alerts.sort((a,b) => parseInt(a.AlertId) - parseInt(b.AlertId));
    
    // await Promise.all(alerts.map(async a => console.log(`id: ${a.AlertId} | start ${a.EventStart} CT | ${await getPostText(a)}`)));
    console.log("Total alerts:", alerts.length);
    
    //headfilt is a list that matches alerts that has the headline and short description fields
    //concatenated
    let headFilt = alerts.map((x: CTAAlert)=>x.Headline + x.ShortDescription)

    // keep the 0th element or keep if there's no duplicate in the preceeding list
    alerts = alerts.filter ( (a: CTAAlert, i: number) => i ==0 || ! (headFilt.slice(0, i - 1).includes(a.Headline + a.ShortDescription)))
    let duplicate_alerts = 
      alerts.filter ( (a: CTAAlert, i: number) => 
        i != 0 && (headFilt.slice(0, i - 1).includes(a.Headline + a.ShortDescription))
      );

    console.log("Alerts remaining after filtering for duplicate headlines:", alerts.length)
    
    console.log('old metra:',
        alerts.filter(
            a => a.Agency === 'metra' && parseInt(a.AlertId) <= metra_parameter
        ).map(x => [x.AlertId, x.Headline])
    )

    // alerts = alerts.filter((a: CTAAlert) => (parseInt(a.AlertId) > cta_parameter && a.Agency == 'cta') 
    //    || (parseInt(a.AlertId) > metra_parameter && a.Agency == 'metra') )
    console.log('metra length:', alerts.filter((a: CTAAlert) => a.Agency === 'metra' ).length)
    //duplicate_alerts = duplicate_alerts.filter((a: CTAAlert) => (parseInt(a.AlertId) > cta_parameter && a.Agency == 'cta') 
    //|| (parseInt(a.AlertId) > metra_parameter && a.Agency == 'metra') )
    console.log("Alerts remaining after filtering on new ID:", alerts.length)
    console.log("Duplicate alerts remaining after filtering on new ID:", duplicate_alerts.length)
    
    // log new ones
    // console.log("logging alerts not seen yet")
    // alerts.map(a => addData(parseInt(a.AlertId), a.Headline, a.ShortDescription, a.EventStart, a.Agency));
    // duplicate_alerts.map(a => addData(parseInt(a.AlertId), a.Headline, a.ShortDescription, a.EventStart, a.Agency));
    
    alerts = alerts.filter ((a: CTAAlert) => (! a.Headline.toLowerCase().includes('elevator'))) 
    console.log("Alerts remaining after filtering on 'elevator':", alerts.length)
    
    
    let DELTA_T = 3600 /* seconds */ * 1000 /* msec */ * 1 /* hours */;
    // let discarded_alerts = alerts.filter ((a: CTAAlert) => getDeltaT(a) >= DELTA_T)
    // await Promise.all(discarded_alerts.map(async (a: CTAAlert) => (
    //   console.log(`[${a.AlertId}] discarded / ${a.EventStart}: ${await getPostText(a)} / start ${Date.parse(a.EventStart)} / now ${Date.now()} / delta ${getDeltaT(a) } (${Math.round(getDeltaT(a)*100 / 3600 / 1000)/100} hours)`)
    // )));
    //alerts = alerts.filter ((a: CTAAlert) => getDeltaT(a) < DELTA_T)
    console.log("Alerts remaining after filtering on last hour:", alerts.length)
    
    
    let posts = await Promise.all(alerts.map( async (alert_: CTAAlert) => {
      const text = await getPostText(alert_);
      if ( alert_.ShortDescription.includes('Metra') ) {
        console.log(`\nPost data:\n   ${alert_.Headline}\n   Short Description: ${alert_.ShortDescription}\n   Full Description: ${alert_.FullDescription['#cdata-section']}\n   tentative text: ${text}`)
      }
      return text;
    }))
    
    // filter posts to only new posts
    var hashset = new Set();
    var values = hashvals.split(',')
    values.map( v => hashset.add(v))
    
    // for post in posts
    // check if post in hashset
    var new_posts = posts.filter(x => (dryRun || (! hashset.has(crypto.createHash('sha256').update(x).digest('base64') ))))
    
    var new_posts_digest = (
        values.concat(
            new_posts.map( x => crypto.createHash('sha256').update(x).digest('base64') )
        ).slice(-1000)
    ).join(',')


    console.log('POSTING')
    
    new_posts.filter(p => p.includes('Metra')).map(p => 
        console.log(
            hashset.has(crypto.createHash('sha256').update(p).digest('base64')) ? 'ALREADY POSTED ONLINE:' : 'FULLY NEW POST:',
            p,
            `(length ${p.length} chars)`
        )
    )
    
    if ( !dryRun ) {
      const promises = new_posts.map(async (text: string) => bot.post(text));
      await Promise.all(promises);
      console.log('result of set value:', await putHash(new_posts_digest) )
    }
    return new_posts;
  }
}
