import { IsString, IsBoolean, IsOptional, IsIn } from 'class-validator';

export class CreateBotDto {
  @IsString()
  name: string;

  @IsIn(['scalping', 'pump'])
  strategy: string;

  @IsString()
  symbol: string;

  @IsIn(['1m', '3m', '5m', '15m'])
  timeframe: string;

  @IsBoolean()
  @IsOptional()
  testMode?: boolean;

  @IsOptional()
  config?: Record<string, any>;
}

export class UpdateBotDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  symbol?: string;

  @IsIn(['1m', '3m', '5m', '15m'])
  @IsOptional()
  timeframe?: string;

  @IsBoolean()
  @IsOptional()
  testMode?: boolean;

  @IsOptional()
  config?: Record<string, any>;
}
