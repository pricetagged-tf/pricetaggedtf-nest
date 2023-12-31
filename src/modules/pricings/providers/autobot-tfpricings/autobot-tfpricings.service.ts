import { HttpService } from '@nestjs/axios'
import * as ld from 'lodash'
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common'
import { firstValueFrom } from 'rxjs'
import { AutobotTFItemEntry, AutobotTFPricesResponse } from './types'
import { IPricingsProviderService } from '../../interfaces/pricings-provider.service.interface'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { Cache } from 'cache-manager'
import { PricingsCache } from '../../models/v1/pricings-cache.data'
import { PricingData } from '../../models/v1/pricings.data'
import { TF2SchemaService } from '../../../tf2-schema/tf2-schema.service'
import sku from '@tf2autobot/tf2-sku'

@Injectable()
export class AutobotTFPricingsService implements IPricingsProviderService {
  private readonly logger = new Logger(AutobotTFPricingsService.name)
  constructor(
    private readonly httpService: HttpService,
    private readonly tf2SchemaService: TF2SchemaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache
  ) {}

  private cacheKey = 'autobot-tf-pricings'
  private cacheTtl = 10 * 60 * 1000

  private async retrieveFromCache(): Promise<PricingsCache | undefined> {
    return await this.cacheManager.get<PricingsCache>(this.cacheKey)
  }

  private async setCache(cache: PricingsCache): Promise<void> {
    this.logger.verbose('settings cache')
    await this.cacheManager.set(this.cacheKey, cache, this.cacheTtl)
  }

  private async getPricings(): Promise<AutobotTFPricesResponse> {
    const { data } = await firstValueFrom(
      this.httpService.get<AutobotTFPricesResponse>('/json/pricelist-array')
    )
    this.logger.log('fetched from autobot.tf')
    return data
  }

  private transformPricings(autobotItems: AutobotTFItemEntry[]): PricingData[] {
    const itemFilteredByDefindex: Record<string, AutobotTFItemEntry[]> = {}
    autobotItems.forEach((item) => {
      const [defIndex] = item.sku.split(';')
      const itemGroup = itemFilteredByDefindex[defIndex]

      if (!itemGroup) {
        itemFilteredByDefindex[defIndex] = [item]
      } else {
        itemGroup.push(item)
      }
    })

    return Object.entries(itemFilteredByDefindex).flatMap<PricingData>(
      ([defIndex, items]) => {
        const baseName = ld.trimStart(
          this.tf2SchemaService.getName({
            defindex: Number(defIndex),
            quality: 6,
          }),
          'The '
        )
        return items.flatMap((item) => {
          const image = this.tf2SchemaService.getImage(sku.fromString(item.sku))
          return {
            baseName,
            image,
            ...item,
          }
        })
      }
    )
  }

  async findAll() {
    const cached = await this.retrieveFromCache()
    if (cached) {
      return cached
    }

    const { success, items } = await this.getPricings()
    if (!success) {
      throw new InternalServerErrorException(
        'Autobot.tf pricelist request failed'
      )
    }

    await this.setCache({
      pricings: this.transformPricings(items),
    })
    return {
      pricings: this.transformPricings(items),
    }
  }

  async refresh(): Promise<void> {
    await this.cacheManager.del(this.cacheKey)
    const { items, success } = await this.getPricings()
    if (!success) {
      return
    }

    await this.setCache({
      pricings: this.transformPricings(items),
    })
  }
}
