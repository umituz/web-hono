export interface ApiEnv {
  DATABASE_URL: string;
  ASSETS: {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  };
}
