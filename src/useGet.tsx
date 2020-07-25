import { useCallback, useContext, useEffect } from "react";
import { Cancelable, DebounceSettings } from "lodash";
import debounce from "lodash/debounce";
import merge from "lodash/merge";
import qs, { IStringifyOptions } from "qs";
import url from "url";
import useSWR, { responseInterface } from "swr";

import { Context, RestfulReactProviderProps } from "./Context";
import { processResponse } from "./util/processResponse";
// import { useDeepCompareEffect } from "./util/useDeepCompareEffect";
import { useAbort } from "./useAbort";

export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

export interface UseGetProps<TData, TError, TQueryParams, TPathParams> {
  /**
   * The path at which to request data,
   * typically composed by parent Gets or the RestfulProvider.
   */
  path: string | ((pathParams: TPathParams) => string);
  /**
   * Path Parameters
   */
  pathParams?: TPathParams;
  /** Options passed into the fetch call. */
  requestOptions?: RestfulReactProviderProps["requestOptions"];
  /**
   * Query parameters
   */
  queryParams?: TQueryParams;
  /**
   * Query parameter stringify options
   */
  queryParamStringifyOptions?: IStringifyOptions;
  /**
   * Don't send the error to the Provider
   */
  localErrorOnly?: boolean;
  /**
   * A function to resolve data return from the backend, most typically
   * used when the backend response needs to be adapted in some way.
   */
  resolve?: (data: any) => TData;
  /**
   * Developer mode
   * Override the state with some mocks values and avoid to fetch
   */
  mock?: { data?: TData; error?: TError; loading?: boolean; response?: Response };
  /**
   * Should we fetch data at a later stage?
   */
  lazy?: boolean;
  /**
   * An escape hatch and an alternative to `path` when you'd like
   * to fetch from an entirely different URL.
   *
   */
  base?: string;
  /**
   * How long do we wait between subsequent requests?
   * Uses [lodash's debounce](https://lodash.com/docs/4.17.10#debounce) under the hood.
   */
  debounce?:
    | {
        wait?: number;
        options: DebounceSettings;
      }
    | boolean
    | number;
}

export function resolvePath<TQueryParams>(
  base: string,
  path: string,
  queryParams: TQueryParams,
  queryParamOptions: IStringifyOptions = {},
) {
  const appendedBase = base.endsWith("/") ? base : `${base}/`;
  const trimmedPath = path.startsWith("/") ? path.slice(1) : path;

  return url.resolve(
    appendedBase,
    Object.keys(queryParams).length ? `${trimmedPath}?${qs.stringify(queryParams, queryParamOptions)}` : trimmedPath,
  );
}

async function _fetchData<TData, TError, TQueryParams, TPathParams>(
  props: UseGetProps<TData, TError, TQueryParams, TPathParams>,
  context: RestfulReactProviderProps,
  abort: () => void,
  getAbortSignal: () => AbortSignal | undefined,
) {
  const {
    base = context.base,
    path,
    resolve = (d: any) => d as TData,
    queryParams = {},
    queryParamStringifyOptions = {},
    requestOptions,
    pathParams = {},
  } = props;

  abort();

  const pathStr = typeof path === "function" ? path(pathParams as TPathParams) : path;

  const propsRequestOptions = (typeof requestOptions === "function" ? await requestOptions() : requestOptions) || {};

  const contextRequestOptions =
    (typeof context.requestOptions === "function" ? await context.requestOptions() : context.requestOptions) || {};

  const signal = getAbortSignal();

  const request = new Request(
    resolvePath(
      base,
      pathStr,
      { ...context.queryParams, ...queryParams },
      { ...context.queryParamStringifyOptions, ...queryParamStringifyOptions },
    ),
    merge({}, contextRequestOptions, propsRequestOptions, { signal }),
  );
  if (context.onRequest) context.onRequest(request);

  try {
    const response = await fetch(request);
    if (context.onResponse) context.onResponse(response.clone());
    const { data, responseError } = await processResponse(response);

    if (signal && signal.aborted) {
      return;
    }

    if (!response.ok || responseError) {
      const error = {
        message: `Failed to fetch: ${response.status} ${response.statusText}${responseError ? " - " + data : ""}`,
        data,
        status: response.status,
      };

      if (!props.localErrorOnly && context.onError) {
        context.onError(error, () => _fetchData(props, context, abort, getAbortSignal), response);
      }

      throw error;
    }

    return resolve(data);
  } catch (e) {
    // avoid state updates when component has been unmounted
    // and when fetch/processResponse threw an error
    if (signal && signal.aborted) {
      return;
    }

    const error = {
      message: `Failed to fetch: ${e.message}`,
      data: e.message,
    };

    if (!props.localErrorOnly && context.onError) {
      context.onError(error, () => _fetchData(props, context, abort, getAbortSignal));
    }

    throw error;
  }
}

type FetchData = typeof _fetchData;
type CancellableFetchData = FetchData | (FetchData & Cancelable);

const isCancellable = <T extends (...args: any[]) => any>(func: T): func is T & Cancelable => {
  return typeof (func as any).cancel === "function" && typeof (func as any).flush === "function";
};

export interface UseGetReturn<TData, TError> extends responseInterface<TData, TError> {
  /**
   * Absolute path resolved from `base` and `path` (context & local)
   */
  absolutePath: string;
  /**
   * Cancel the current fetch
   */
  cancel: () => void;
}

export function useGet<TData = any, TError = any, TQueryParams = { [key: string]: any }, TPathParams = unknown>(
  path: UseGetProps<TData, TError, TQueryParams, TPathParams>["path"],
  props?: Omit<UseGetProps<TData, TError, TQueryParams, TPathParams>, "path">,
): UseGetReturn<TData, TError>;

export function useGet<TData = any, TError = any, TQueryParams = { [key: string]: any }, TPathParams = unknown>(
  props: UseGetProps<TData, TError, TQueryParams, TPathParams>,
): UseGetReturn<TData, TError>;

export function useGet<TData = any, TError = any, TQueryParams = { [key: string]: any }, TPathParams = unknown>() {
  const props: UseGetProps<TData, TError, TQueryParams, TPathParams> =
    typeof arguments[0] === "object" ? arguments[0] : { ...arguments[1], path: arguments[0] };

  const context = useContext(Context);
  const { path, pathParams = {} } = props;

  const fetchData = useCallback<CancellableFetchData>(
    typeof props.debounce === "object"
      ? debounce<FetchData>(_fetchData, props.debounce.wait, props.debounce.options)
      : typeof props.debounce === "number"
      ? debounce<FetchData>(_fetchData, props.debounce)
      : props.debounce
      ? debounce<FetchData>(_fetchData)
      : _fetchData,
    [props.debounce],
  );

  // Cancel fetchData on unmount (if debounce)
  useEffect(() => (isCancellable(fetchData) ? () => fetchData.cancel() : undefined), [fetchData]);

  const { abort, getAbortSignal } = useAbort();

  const pathStr = typeof path === "function" ? path(pathParams as TPathParams) : path;

  const swr = useSWR(pathStr, () => fetchData(props, context, abort, getAbortSignal), {
    suspense: true,
  });
  console.log(pathStr);

  /*
  useDeepCompareEffect(() => {
    if (!props.lazy && !props.mock) {
      fetchData(props, state, setState, context, abort, getAbortSignal);
    }

    return () => {
      abort();
    };
  }, [
    props.lazy,
    props.mock,
    props.path,
    props.base,
    props.resolve,
    props.queryParams,
    props.requestOptions,
    props.pathParams,
    context.base,
    context.parentPath,
    context.queryParams,
    context.requestOptions,
    abort,
  ]);
  */

  return {
    ...swr,
    absolutePath: resolvePath(
      props.base || context.base,
      pathStr,
      {
        ...context.queryParams,
        ...props.queryParams,
      },
      {
        ...context.queryParamStringifyOptions,
        ...props.queryParamStringifyOptions,
      },
    ),
    cancel: () => {
      abort();
    },
  };
}
