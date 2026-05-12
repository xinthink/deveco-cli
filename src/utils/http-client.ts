/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  AxiosError,
} from 'axios';
import { NetworkConstants, TimeConstants } from '../config/constants';
import type { HttpResponse, HttpRequestConfig } from '../types/http';

/**
 * HTTP 客户端类
 * 封装 axios，提供简化的请求接口
 */
export class HttpClient {
  private client: AxiosInstance;

  constructor() {
    const axiosConfig: AxiosRequestConfig = {
      timeout: TimeConstants.HTTP_TIMEOUT_MS,
      headers: {
        'User-Agent': NetworkConstants.USER_AGENT,
        'accept-language': NetworkConstants.ACCEPT_LANGUAGE,
      },
      transformResponse: [(data) => data],
      proxy: false,
    };

    this.client = axios.create(axiosConfig);

    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        const proxyHint = `Network connection failed (${error.code}). Please check your proxy configuration or network settings`;
        throw new Error(`${error.message}\n${proxyHint}`);
      }
    );
  }

  /**
   * 发送 GET 请求
   * @param url 请求 URL
   * @param config 请求配置
   * @returns HTTP 响应
   */
  public async get(
    url: string,
    config?: HttpRequestConfig
  ): Promise<HttpResponse> {
    const response = await this.client.request({
      method: 'GET',
      url,
      params: config?.params,
      headers: config?.headers,
      timeout: config?.timeout,
    });
    return this.convertResponse(response);
  }

  /**
   * 发送 POST 请求
   * @param url 请求 URL
   * @param config 请求配置
   * @returns HTTP 响应
   */
  public async post(
    url: string,
    config?: HttpRequestConfig
  ): Promise<HttpResponse> {
    const response = await this.client.request({
      method: 'POST',
      url,
      data: config?.params,
      headers: config?.headers,
      timeout: config?.timeout,
    });
    return this.convertResponse(response);
  }

  /**
   * 将 axios 响应转换为统一的 HttpResponse 格式
   * @param response axios 响应
   * @returns 统一的 HTTP 响应格式
   */
  private convertResponse(response: AxiosResponse): HttpResponse {
    return {
      data:
        typeof response.data === 'string'
          ? response.data
          : JSON.stringify(response.data),
      statusCode: response.status,
      headers: response.headers as Record<
        string,
        string | string[] | undefined
      >,
    };
  }

  /**
   * 解析 JSON 响应
   * @param response HTTP 响应
   * @returns 解析后的 JSON 对象
   */
  public parseJson<T>(response: HttpResponse): T {
    return JSON.parse(response.data) as T;
  }

  /**
   * 发送 GET 请求并返回二进制数据
   * 用于下载文件等场景
   * @param url 请求 URL
   * @param config 请求配置
   * @returns Buffer 数据
   */
  public async getBinary(
    url: string,
    config?: HttpRequestConfig
  ): Promise<Buffer> {
    const response = await this.client.request({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      headers: config?.headers,
      timeout: config?.timeout,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    return Buffer.from(response.data);
  }
}

/** HTTP 客户端单例实例 */
export const httpClient = new HttpClient();
