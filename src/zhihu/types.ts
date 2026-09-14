export type ZhihuUser = {
  id: string;
  hashId?: string;
  fullname: string;
  gender?: string;
  headline?: string;
  description?: string;
  avatarPath?: string;
  url?: string;
};

export type ZhihuOAuthToken = {
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
  refreshToken?: string;
};
