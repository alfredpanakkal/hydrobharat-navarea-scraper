import { CONFIG } from '../config';

export interface LiferayDocument {
  id: number;
  title: string;
  dateCreated: string;
  contentUrl: string;
}

export interface PaginatedResponse {
  items: LiferayDocument[];
  page: number;
  pageSize: number;
  lastPage: number;
  totalCount: number;
}

export class LiferayClient {
  private auth: string;
  private baseUrl: string;
  private folderId: number;

  constructor() {
    this.auth = Buffer.from(`${CONFIG.LIFERAY_USER}:${CONFIG.LIFERAY_PASS}`).toString('base64');
    this.baseUrl = CONFIG.LIFERAY_API_BASE;
    this.folderId = CONFIG.LIFERAY_FOLDER_ID;
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Liferay API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  async listDocuments(page: number = 1, pageSize: number = 20): Promise<PaginatedResponse> {
    const path = `/document-folders/${this.folderId}/documents?page=${page}&pageSize=${pageSize}&sort=dateCreated:desc&fields=id,title,dateCreated,contentUrl`;
    return this.request<PaginatedResponse>(path);
  }

  async listAllDocuments(): Promise<LiferayDocument[]> {
    const allDocs: LiferayDocument[] = [];
    let page = 1;
    let lastPage = 1;

    while (page <= lastPage) {
      const response = await this.listDocuments(page);
      allDocs.push(...response.items);
      lastPage = response.lastPage;
      page++;
    }

    return allDocs;
  }

  async downloadPdf(document: LiferayDocument): Promise<Buffer> {
    const url = `https://hydrobharat.gov.in${document.contentUrl}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${this.auth}`,
      },
    });

    if (!response.ok) {
      throw new Error(`PDF download failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
