import dotenv from 'dotenv'
import Joi from 'joi'


const schema: Joi.ObjectSchema = Joi.object({
    GAS_ORACLE_URL: Joi.string().uri().optional().allow(''),
    NODE_API_URL: Joi.string().uri().required(),
    PRIVATE_KEY: Joi.string().required(),
    FLASHLOAN_ADDRESS: Joi.string().required(),
    BORROWED_AMOUNT: Joi.number().required(),
    KLIMA_ADDRESS: Joi.string().required(),
    USDC_ADDRESS: Joi.string().required(),
    BCT_ADDRESS: Joi.string().required(),
    NCT_ADDRESS: Joi.string().required(),
    MCO2_ADDRESS: Joi.string().required(),
    USDC_MCO2_ADDRESS: Joi.string().required(),
    KLIMA_MCO2_ADDRESS: Joi.string().required(),
})

export class ConfigService {
    private config

    constructor() {
      const { parsed: parsedConfig, error: parseError } = dotenv.config()
      if (parseError) {
        console.log(`No .env file found, config.get will use process.env`)
        return
      }
      const { error: validationError, value: config } = schema.validate(parsedConfig)
      if (validationError) {
        throw Error(`Failed to validate config: ${validationError}`)
      }
      this.config = config
    }

    get(key: string): string {
      try {
        return process.env[key] || this.config[key]
      } catch {
        return ''
      }
    }
}

export const config = new ConfigService()
