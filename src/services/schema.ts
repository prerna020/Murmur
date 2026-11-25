import { z } from 'zod';
import { MoodType, TopicType } from '../types/journal';

export const MOODS: readonly MoodType[] = [
  'happy',
  'calm',
  'neutral',
  'stressed',
  'sad',
  'angry',
] as const;

export const TOPICS: readonly TopicType[] = [
  'work_study',
  'relationships',
  'family',
  'health',
  'money',
  'goals',
  'leisure',
  'other',
] as const;

export const ExtractionSchema = z.object({
  mood: z.enum(['happy', 'calm', 'neutral', 'stressed', 'sad', 'angry'], {
    message: 'mood must be one of: happy, calm, neutral, stressed, sad, angry',
  }),
  topics: z
    .array(
      z.enum([
        'work_study',
        'relationships',
        'family',
        'health',
        'money',
        'goals',
        'leisure',
        'other',
      ])
    )
    .min(1, 'topics must have at least 1 item')
    .max(3, 'topics cannot have more than 3 items'),
  summary: z
    .string()
    .min(1, 'summary cannot be empty')
    .refine(
      (val) => {
        const words = val.trim().split(/\s+/).filter(Boolean);
        return words.length <= 25;
      },
      { message: 'summary must be a single sentence of maximum 25 words' }
    ),
});

export type ValidatedExtraction = z.infer<typeof ExtractionSchema>;
