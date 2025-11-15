import axios from "axios";
import admin from 'firebase-admin';
import protobuf from "protobufjs";
import { existsSync } from "node:fs";
import path from "node:path";

import { bskyAccount, bskyService, firebaseServiceAccount, metraApiToken } from "./config.js";
import type {
  CTAData, CTAAlert, MetraEntity, MetraAlert
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

const GTFS_PROTO_PATHS = [
  path.resolve(process.cwd(), "dist/lib/gtfs-realtime.proto"),
  path.resolve(process.cwd(), "src/lib/gtfs-realtime.proto"),
];

type MetraProtoTypes = {
  FeedMessage: protobuf.Type;
  EntitySelector: protobuf.Type;
  TimeRange: protobuf.Type;
};

let cachedMetraProto: MetraProtoTypes | null = null;

async function loadMetraProto(): Promise<MetraProtoTypes> {
  if (cachedMetraProto) {
    return cachedMetraProto;
  }

  let lastError: unknown = null;
  for (const candidate of GTFS_PROTO_PATHS) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const root = await protobuf.load(candidate);
      cachedMetraProto = {
        FeedMessage: root.lookupType("transit_realtime.FeedMessage"),
        EntitySelector: root.lookupType("transit_realtime.EntitySelector"),
        TimeRange: root.lookupType("transit_realtime.TimeRange"),
      };
      return cachedMetraProto;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Unable to locate GTFS proto definition for Metra alerts");
}

const toNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof (value as { toNumber?: () => number }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { low?: number }).low === "number" &&
    typeof (value as { high?: number }).high === "number"
  ) {
    const { low = 0, high = 0 } = value as { low: number; high: number };
    return high * 0x100000000 + (low >>> 0);
  }
  return undefined;
};

const firstTranslationText = (
  field?: { translation?: Array<{ text?: string | null }> }
): string => {
  if (!field?.translation?.length) {
    return "";
  }
  const candidate = field.translation.find(
    (item) => typeof item?.text === "string" && item.text.trim().length > 0
  );
  return (candidate?.text ?? "").trim();
};

const sanitizeDescription = (text: string): string =>
  text
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/&[a-z]*;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const secondsToIso = (seconds?: number): string =>
  typeof seconds === "number"
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();

async function parseMetraEntities(feedData: Uint8Array): Promise<MetraEntity[]> {
  const { FeedMessage, EntitySelector, TimeRange } = await loadMetraProto();
  const feedMessage = FeedMessage.decode(feedData) as unknown as {
    entity?: Array<Record<string, unknown>>;
  };

  const rawEntities = feedMessage.entity ?? [];

  return rawEntities
    .filter((entity) => entity?.alert)
    .map((entity) => {
      const alert = entity.alert as Record<string, unknown>;
      const rawInformed = (alert?.informedEntity as Uint8Array[] | undefined) ?? [];
      const informedEntities = rawInformed.map((raw) => {
        const decoded = EntitySelector.decode(raw) as unknown as Record<string, unknown>;
        const trip = decoded.trip as Record<string, unknown> | undefined;
        return {
          agencyId:
            (decoded.agencyId as string | undefined) ??
            (decoded.agency_id as string | undefined),
          routeId:
            (decoded.routeId as string | undefined) ??
            (decoded.route_id as string | undefined) ??
            (trip?.routeId as string | undefined) ??
            (trip?.route_id as string | undefined),
          stopId:
            (decoded.stopId as string | undefined) ??
            (decoded.stop_id as string | undefined) ??
            (decoded.stopIdLegacy as string | undefined),
        };
      });

      const rawPeriods = (alert?.activePeriod as Uint8Array[] | undefined) ?? [];
      const activePeriods = rawPeriods.map((raw) => {
        const decoded = TimeRange.decode(raw) as unknown as Record<string, unknown>;
        return {
          start: toNumber(decoded.start),
          end: toNumber(decoded.end),
        };
      });

      const metraAlert: MetraAlert = {
        url: alert.url as MetraAlert["url"],
        headerText: alert.headerText as MetraAlert["headerText"],
        descriptionText: alert.descriptionText as MetraAlert["descriptionText"],
        informedEntities,
        activePeriods,
      };

      return {
        id: (entity.id as string) ?? "",
        isDeleted: (entity.isDeleted as boolean | undefined) ?? false,
        alert: metraAlert,
      };
    });
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
          output = await this.#agent.post(record);
      } catch {
          console.log("ERROR: in try/catch block");
          console.log("Erroring post text:");
          console.log(record.text);
          output = '';
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
    try {
        var alerts = (
          await 
            axios.get<CTAData>(
            'http://www.transitchicago.com/api/1.0/alerts.aspx?outputType=JSON&accessibility=FALSE&activeonly=TRUE'
            )
        ).data.CTAAlerts.Alert;
    } catch {
        var alerts: CTAAlert[]  = []
    }

    alerts = alerts.map (a => {
        let b = a;
        b.Agency = 'cta';
        return b;
    })

    let metra_alerts: MetraEntity[] = [];
    try {
        const response = await axios.get<ArrayBuffer>(
            `https://gtfspublic.metrarr.com/gtfs/public/alerts?api_token=${encodeURIComponent(metraApiToken)}`,
            { responseType: 'arraybuffer' }
        );
        const rawData = response.data;
        const bytes = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
        metra_alerts = await parseMetraEntities(bytes);
    } catch (error) {
        console.error('Failed to fetch Metra GTFS alerts:', error);
        metra_alerts = [];
    }

    metra_alerts = metra_alerts.filter(
        (entity) => entity.alert !== undefined && !entity.isDeleted
    );

    const regex = /reminder|reopen|elevator|extra service|pedestrian crossing to close|tracks.*out of service|temporary.*platform.*will move/i ;
    
    const headlineFor = (entity: MetraEntity): string =>
        entity.alert ? firstTranslationText(entity.alert.headerText) : '';

    // artificial debugging, shows what failed
    console.log('\n\nregex match, excluded\n')
    console.log(metra_alerts
        // true if matches exclusion words
        .filter( x => regex.test(headlineFor(x)) )
        .map(x => headlineFor(x)))
    
    metra_alerts = metra_alerts.filter(
        x => {
            const if_matches_exclusions = regex.test(headlineFor(x));
            return (! if_matches_exclusions)
        }
    )
    console.log('\n\nremaining\n')
    console.log(metra_alerts
        .map(x => [headlineFor(x),  regex.test(headlineFor(x))])
    )
    metra_alerts.sort((a,b) => {
        const aId = parseInt(a.id.replace(/[^0-9]/g, '') || '0', 10);
        const bId = parseInt(b.id.replace(/[^0-9]/g, '') || '0', 10);
        return aId - bId;
    });

    const rt_regex = /[A-Z][A-Z]-?[A-Z]?/g;
    const alert_texts: Array<{id: string, text: string}> = [];

    for (const entity of metra_alerts) {
        const alert = entity.alert;
        if (!alert) continue;

        const headline = firstTranslationText(alert.headerText);
        const matches = headline.match(rt_regex);
        const routeFromHeadline = matches ? matches[0] : '';

        let description = sanitizeDescription(firstTranslationText(alert.descriptionText));
        if (description.length === 0) {
            description = headline;
        }

        const informedRoute = alert.informedEntities[0]?.routeId ?? routeFromHeadline;
        if (!informedRoute) {
            continue;
        }

        const primarySentence =
            description
                .split('&nbsp;')
                .map((segment) => segment.trim())
                .find((segment) => segment.length > 0) ?? description;

        const full_text = `🚆 Metra${informedRoute ? ' ' + informedRoute : ''}: ${primarySentence}`;
        alert_texts.push({id: entity.id, text: full_text});
    }

    metra_alerts.map(
        alert => {
            const full_text_items = alert_texts.filter( x => x.id === alert.id);
            const full_text = full_text_items.length > 0 ? full_text_items[0].text : '';
            const alertDetails = alert.alert;
            if (!full_text || !alertDetails) {
                return;
            }

            const eventStartSeconds = alertDetails.activePeriods[0]?.start;
            const eventEndSeconds = alertDetails.activePeriods[0]?.end;

            alerts.push( {
                Agency: 'metra',
                AlertId: alert.id.replace(/[^0-9]/g, '') || String(Date.now()),
                Headline: firstTranslationText(alertDetails.headerText),
                ShortDescription: full_text,
                FullDescription: {['#cdata-section']: full_text},
                SeverityColor: '',
                SeverityScore: '',
                SeverityCSS: '',
                Impact: '',
                EventStart: secondsToIso(eventStartSeconds),
                EventEnd: secondsToIso(eventEndSeconds),
                TBD: '',
                MajorAlert: '',
                AlertURL: {['#cdata-section']: firstTranslationText(alertDetails.url)},
                ImpactedService: {Service: []},
                ttim: '',
                GUID: ''
            })
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
