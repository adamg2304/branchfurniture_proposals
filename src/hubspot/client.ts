import { Client } from "@hubspot/api-client";

let client: Client | undefined;

export function getHubSpotClient(accessToken: string): Client {
  if (!client) {
    client = new Client({ accessToken });
  }
  return client;
}
