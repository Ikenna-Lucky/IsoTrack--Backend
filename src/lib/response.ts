import type { Context } from "hono";

type SuccessOptions<T> = {
  data: T;
  message?: string;
  status?: 200 | 201;
};

type PaginatedOptions<T> = {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  message?: string;
};

export function success<T>(c: Context, options: SuccessOptions<T>) {
  return c.json(
    {
      success: true,
      message: options.message,
      data: options.data,
    },
    options.status ?? 200,
  );
}

export function paginated<T>(c: Context, options: PaginatedOptions<T>) {
  return c.json(
    {
      success: true,
      message: options.message,
      data: options.data,
      pagination: options.pagination,
    },
    200,
  );
}

export function error(
  c: Context,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 | 503 = 400,
) {
  const errorCodes: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "UNPROCESSABLE_ENTITY",
    500: "INTERNAL_SERVER_ERROR",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE",
  };
  return c.json(
    {
      success: false,
      error: errorCodes[status] ?? "ERROR",
      message,
    },
    status,
  );
}
