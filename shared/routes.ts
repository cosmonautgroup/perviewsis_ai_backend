import { z } from 'zod';
import { 
  connectionSchema, applicationSchema, businessTransactionSchema,
  nodeSchema, problemSchema, incidentSchema, forecastSchema, capacitySchema,
  metricDataSchema
} from './schema';

export const errorSchemas = {
  validation: z.object({ message: z.string(), field: z.string().optional() }),
  internal: z.object({ message: z.string() }),
  notFound: z.object({ message: z.string() })
};

export const api = {
  auth: {
    connect: {
      method: 'POST' as const,
      path: '/api/connect' as const,
      input: connectionSchema,
      responses: {
        200: z.object({ success: z.boolean(), message: z.string() }),
        400: errorSchemas.validation,
        401: z.object({ message: z.string() })
      }
    },
    status: {
      method: 'GET' as const,
      path: '/api/connect/status' as const,
      responses: {
        200: z.object({ connected: z.boolean(), useMock: z.boolean() })
      }
    }
  },
  applications: {
    list: {
      method: 'GET' as const,
      path: '/api/applications' as const,
      responses: {
        200: z.array(applicationSchema)
      }
    },
    get: {
      method: 'GET' as const,
      path: '/api/applications/:id' as const,
      responses: {
        200: applicationSchema,
        404: errorSchemas.notFound
      }
    },
    transactions: {
      method: 'GET' as const,
      path: '/api/applications/:id/transactions' as const,
      responses: {
        200: z.array(businessTransactionSchema)
      }
    },
    nodes: {
      method: 'GET' as const,
      path: '/api/applications/:id/nodes' as const,
      responses: {
        200: z.array(nodeSchema)
      }
    },
    metrics: {
      method: 'GET' as const,
      path: '/api/applications/:id/metrics' as const,
      input: z.object({ metricName: z.string() }).optional(),
      responses: {
        200: z.array(metricDataSchema)
      }
    },
    incidents: {
      method: 'GET' as const,
      path: '/api/applications/:id/incidents' as const,
      responses: {
        200: z.array(incidentSchema)
      }
    },
    forecast: {
      method: 'GET' as const,
      path: '/api/applications/:id/forecast' as const,
      responses: {
        200: z.array(forecastSchema)
      }
    },
    capacity: {
      method: 'GET' as const,
      path: '/api/applications/:id/capacity' as const,
      responses: {
        200: z.array(capacitySchema)
      }
    }
  },
  problems: {
    get: {
      method: 'GET' as const,
      path: '/api/problems/:id' as const,
      responses: {
        200: problemSchema,
        404: errorSchemas.notFound
      }
    },
    metrics: {
      method: 'GET' as const,
      path: '/api/problems/:id/metrics' as const,
      responses: {
        200: z.object({
           before: z.array(metricDataSchema),
           during: z.array(metricDataSchema),
           after: z.array(metricDataSchema)
        })
      }
    }
  }
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
