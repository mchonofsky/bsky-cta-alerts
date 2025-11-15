
export interface MetraTranslation {
  text?: string;
  language?: string;
}

export interface MetraEntitySelector {
  agencyId?: string;
  routeId?: string;
  stopId?: string;
}

export interface MetraAlert {
  url?: { translation?: MetraTranslation[] };
  headerText?: { translation?: MetraTranslation[] };
  descriptionText?: { translation?: MetraTranslation[] };
  informedEntities: MetraEntitySelector[];
  activePeriods: Array<{ start?: number; end?: number }>;
}

export interface MetraEntity {
  id: string;
  isDeleted?: boolean;
  alert?: MetraAlert;
}
export interface CTAData {
    CTAAlerts: {
      Alert: CTAAlert[]; // This is an array of CTAAlert objects
    };
}

export interface CTAAlert {
  Agency: string;
  AlertId: string;
  Headline: string;
  ShortDescription: string;
  FullDescription: { '#cdata-section': string };
  SeverityScore: string;
  SeverityColor: string;
  SeverityCSS: string;
  Impact: string;
  EventStart: string;
  EventEnd: string | null;
  TBD: string;
  MajorAlert: string;
  AlertURL: { '#cdata-section': string };
  ImpactedService: { Service: any[] }; // You might want to define a more specific interface for Service
  ttim: string;
  GUID: string;
}
